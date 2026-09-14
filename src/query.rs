//! Read-side queries. Every one of these runs against the raw parquet views;
//! nothing is materialised, cached on disk, or precomputed.

use anyhow::{anyhow, Result};
use std::collections::BTreeMap;
use std::io::{self, Write};

use crate::db::{quote_ident, Db};
use crate::json::{Object, ToJson};

// ---------------------------------------------------------------- coverage --

#[derive(Debug, Clone)]
pub struct Coverage {
    pub bucket_us: i64,
    /// Per series: the half-open [start, end) windows that actually hold rows.
    pub series: BTreeMap<String, Vec<[i64; 2]>>,
    /// Union across series -- what the timeline collapses gaps against.
    pub union: Vec<[i64; 2]>,
}

impl ToJson for Coverage {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        Object::new(w)?
            .field("bucket_us", &self.bucket_us)?
            .field("series", &self.series)?
            .field("union", &self.union)?
            .end()
    }
}

/// Finds the occupied stretches of wall-clock time by bucketing `ts` and
/// merging adjacent buckets. Only the `ts` column is read, so this stays fast
/// even across the whole store.
pub fn coverage(db: &Db, bucket_us: i64) -> Result<Coverage> {
    let bucket_us = bucket_us.max(1);
    let conn = db.lease()?;
    let mut per_series = BTreeMap::new();
    let mut all: Vec<i64> = Vec::new();

    for info in &db.catalog.series {
        let sql = format!(
            "SELECT DISTINCT epoch_us(ts) // {bucket_us} AS b FROM {} ORDER BY b",
            quote_ident(&info.name)
        );
        let mut stmt = conn.prepare(&sql)?;
        let buckets: Vec<i64> = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<std::result::Result<_, _>>()?;
        all.extend_from_slice(&buckets);
        per_series.insert(info.name.clone(), merge(&buckets, bucket_us));
    }

    all.sort_unstable();
    all.dedup();

    Ok(Coverage {
        bucket_us,
        series: per_series,
        union: merge(&all, bucket_us),
    })
}

/// Turns a sorted bucket-index list into half-open time spans, joining buckets
/// that sit next to each other.
fn merge(buckets: &[i64], bucket_us: i64) -> Vec<[i64; 2]> {
    let mut spans: Vec<[i64; 2]> = Vec::new();
    for &b in buckets {
        match spans.last_mut() {
            Some(last) if b * bucket_us <= last[1] => last[1] = (b + 1) * bucket_us,
            _ => spans.push([b * bucket_us, (b + 1) * bucket_us]),
        }
    }
    spans
}

// -------------------------------------------------------------------- data --

/// Arrays a mode does not use are left out of the JSON, not sent as `null`.
#[derive(Debug, Clone, Default)]
pub struct ChannelData {
    /// Present in `raw` mode: the actual recorded value.
    pub v: Option<Vec<Option<f64>>>,
    /// Present in `agg` mode: per-bucket envelope and endpoints.
    pub lo: Option<Vec<Option<f64>>>,
    pub hi: Option<Vec<Option<f64>>>,
    pub first: Option<Vec<Option<f64>>>,
    pub last: Option<Vec<Option<f64>>>,
}

impl ToJson for ChannelData {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        Object::new(w)?
            .field_if_some("v", &self.v)?
            .field_if_some("lo", &self.lo)?
            .field_if_some("hi", &self.hi)?
            .field_if_some("first", &self.first)?
            .field_if_some("last", &self.last)?
            .end()
    }
}

#[derive(Debug, Clone)]
pub struct SeriesData {
    /// `raw` = every recorded point in the window, untouched.
    /// `agg` = per-bucket min/max/first/last, computed on the fly.
    pub mode: &'static str,
    /// Raw rows the window holds, whichever mode was used.
    pub rows: i64,
    pub bucket_us: i64,
    /// Point time in epoch micros (exact `ts` in raw mode, bucket start in agg).
    pub t: Vec<i64>,
    pub channels: BTreeMap<String, ChannelData>,
}

impl ToJson for SeriesData {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        Object::new(w)?
            .field("mode", self.mode)?
            .field("rows", &self.rows)?
            .field("bucket_us", &self.bucket_us)?
            .field("t", &self.t)?
            .field("channels", &self.channels)?
            .end()
    }
}

#[derive(Debug, Clone)]
pub struct DataResponse {
    pub from: i64,
    pub to: i64,
    /// Bucket count actually used, after the point budget had its say.
    pub buckets: i64,
    /// Raw threshold actually used, likewise.
    pub max_raw: i64,
    /// Values carried by this response -- what it costs to hold in memory.
    pub points: i64,
    /// True when the point budget reduced `buckets` or `max_raw`.
    pub capped: bool,
    pub series: BTreeMap<String, SeriesData>,
}

impl ToJson for DataResponse {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        Object::new(w)?
            .field("from", &self.from)?
            .field("to", &self.to)?
            .field("buckets", &self.buckets)?
            .field("max_raw", &self.max_raw)?
            .field("points", &self.points)?
            .field("capped", &self.capped)?
            .field("series", &self.series)?
            .end()
    }
}

pub struct DataRequest<'a> {
    pub from: i64,
    pub to: i64,
    pub buckets: i64,
    /// Below this many rows in the window a series is served raw, unaggregated.
    pub max_raw: i64,
    /// Ceiling on the values one response may materialise. Bucket count and the
    /// raw threshold are both trimmed to respect it, so neither a wide window
    /// nor a generous raw budget can pull an unbounded result into memory.
    pub max_points: i64,
    /// `<series>:<field>` ids.
    pub channels: &'a [String],
}

pub fn data(db: &Db, req: &DataRequest) -> Result<DataResponse> {
    if req.to <= req.from {
        return Err(anyhow!("empty window: from must be < to"));
    }

    // Group the requested channels by series so each series costs one scan.
    let mut wanted: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in req.channels {
        let (series, field) = id
            .split_once(':')
            .ok_or_else(|| anyhow!("bad channel id `{id}`, expected `<series>:<field>`"))?;
        let info = db
            .series(series)
            .ok_or_else(|| anyhow!("unknown series `{series}`"))?;
        if !info.channels.iter().any(|c| c.field == field) {
            return Err(anyhow!("unknown channel `{id}`"));
        }
        let fields = wanted.entry(series.to_string()).or_default();
        if !fields.iter().any(|f| f == field) {
            fields.push(field.to_string());
        }
    }

    // What one point of each shape costs, so the budget can be spent honestly:
    // an agg bucket carries min/max/first/last per channel plus one timestamp
    // per series, a raw row carries one value per channel plus its timestamp.
    let n_channels: i64 = wanted.values().map(|f| f.len() as i64).sum();
    let n_series = wanted.len() as i64;
    let agg_cost = (4 * n_channels + n_series).max(1);
    let raw_cost = (n_channels + n_series).max(1);

    let asked_buckets = req.buckets.clamp(1, 20_000);
    let buckets = asked_buckets.min((req.max_points / agg_cost).max(1));
    let max_raw = req.max_raw.min((req.max_points / raw_cost).max(1));
    let capped = buckets < asked_buckets || max_raw < req.max_raw;
    let bucket_us = (((req.to - req.from) as f64) / buckets as f64).ceil().max(1.0) as i64;

    let conn = db.lease()?;
    let mut out = BTreeMap::new();
    for (series, fields) in &wanted {
        let ident = quote_ident(series);
        let window = format!(
            "ts >= make_timestamp({}) AT TIME ZONE 'UTC' AND ts < make_timestamp({}) AT TIME ZONE 'UTC'",
            req.from, req.to
        );

        let rows: i64 = conn.query_row(
            &format!("SELECT count(*) FROM {ident} WHERE {window}"),
            [],
            |row| row.get(0),
        )?;

        let sd = if rows <= max_raw {
            fetch_raw(&conn, &ident, &window, fields)?
        } else {
            fetch_agg(&conn, &ident, &window, fields, req.from, bucket_us)?
        };
        out.insert(
            series.clone(),
            SeriesData {
                rows,
                ..sd
            },
        );
    }

    let points: i64 = out
        .values()
        .map(|sd| {
            let per_channel: i64 = sd
                .channels
                .values()
                .map(|c| {
                    [&c.v, &c.lo, &c.hi, &c.first, &c.last]
                        .iter()
                        .filter_map(|a| a.as_ref())
                        .map(|a| a.len() as i64)
                        .sum::<i64>()
                })
                .sum();
            per_channel + sd.t.len() as i64
        })
        .sum();

    Ok(DataResponse {
        from: req.from,
        to: req.to,
        buckets,
        max_raw,
        points,
        capped,
        series: out,
    })
}

fn fetch_raw(
    conn: &duckdb::Connection,
    ident: &str,
    window: &str,
    fields: &[String],
) -> Result<SeriesData> {
    let cols: Vec<String> = fields
        .iter()
        .enumerate()
        .map(|(i, f)| format!("CAST({} AS DOUBLE) AS c{i}", quote_ident(f)))
        .collect();
    let sql = format!(
        "SELECT epoch_us(ts) AS t, {} FROM {ident} WHERE {window} ORDER BY ts",
        cols.join(", ")
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut t = Vec::new();
    let mut vals: Vec<Vec<Option<f64>>> = vec![Vec::new(); fields.len()];
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        t.push(row.get::<_, i64>(0)?);
        for (i, col) in vals.iter_mut().enumerate() {
            col.push(row.get::<_, Option<f64>>(i + 1)?);
        }
    }

    let channels = fields
        .iter()
        .zip(vals)
        .map(|(f, v)| {
            (
                f.clone(),
                ChannelData { v: Some(v), ..Default::default() },
            )
        })
        .collect();

    Ok(SeriesData {
        mode: "raw",
        rows: t.len() as i64,
        bucket_us: 0,
        t,
        channels,
    })
}

fn fetch_agg(
    conn: &duckdb::Connection,
    ident: &str,
    window: &str,
    fields: &[String],
    from: i64,
    bucket_us: i64,
) -> Result<SeriesData> {
    let mut cols: Vec<String> = Vec::new();
    for f in fields {
        let q = quote_ident(f);
        let v = format!("CAST({q} AS DOUBLE)");
        cols.push(format!("min({v})"));
        cols.push(format!("max({v})"));
        cols.push(format!("arg_min({v}, ts)"));
        cols.push(format!("arg_max({v}, ts)"));
    }
    let sql = format!(
        "SELECT (epoch_us(ts) - {from}) // {bucket_us} AS b, {} \
         FROM {ident} WHERE {window} GROUP BY b ORDER BY b",
        cols.join(", ")
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut t = Vec::new();
    let n = fields.len();
    let mut lo: Vec<Vec<Option<f64>>> = vec![Vec::new(); n];
    let mut hi: Vec<Vec<Option<f64>>> = vec![Vec::new(); n];
    let mut first: Vec<Vec<Option<f64>>> = vec![Vec::new(); n];
    let mut last: Vec<Vec<Option<f64>>> = vec![Vec::new(); n];

    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let b = row.get::<_, i64>(0)?;
        t.push(from + b * bucket_us);
        for i in 0..n {
            let base = 1 + i * 4;
            lo[i].push(row.get::<_, Option<f64>>(base)?);
            hi[i].push(row.get::<_, Option<f64>>(base + 1)?);
            first[i].push(row.get::<_, Option<f64>>(base + 2)?);
            last[i].push(row.get::<_, Option<f64>>(base + 3)?);
        }
    }

    let mut channels = BTreeMap::new();
    for (i, f) in fields.iter().enumerate() {
        channels.insert(
            f.clone(),
            ChannelData {
                lo: Some(std::mem::take(&mut lo[i])),
                hi: Some(std::mem::take(&mut hi[i])),
                first: Some(std::mem::take(&mut first[i])),
                last: Some(std::mem::take(&mut last[i])),
                ..Default::default()
            },
        );
    }

    Ok(SeriesData {
        mode: "agg",
        rows: 0,
        bucket_us,
        t,
        channels,
    })
}
