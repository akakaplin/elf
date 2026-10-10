//! Read-side queries. Every one of these runs against the raw parquet views;
//! nothing is materialised or cached on disk. Coverage is the one answer kept
//! in memory between requests -- see `coverage.rs` -- and this defines its
//! shape.

use std::collections::BTreeMap;
use std::io::{self, Write};

use crate::db::{quote_ident, Db};
use crate::duck::Connection;
use crate::error::{err, Result};
use crate::json::{Object, ToJson};

// ---------------------------------------------------------------- coverage --

#[derive(Debug, Clone)]
pub struct Coverage {
    pub bucket_us: i64,
    /// Per series: the half-open [start, end) windows that actually hold rows,
    /// joined across gaps up to the request's `merge_ms`.
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
    /// Present in `agg` mode: the latest `ts` in each bucket, which is when its
    /// `last` value was actually recorded. Anything that treats `last` as a
    /// reading must place it here, not at the bucket start, or it reads a value
    /// up to a bucket before it existed.
    pub t_last: Option<Vec<i64>>,
    pub channels: BTreeMap<String, ChannelData>,
}

impl ToJson for SeriesData {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        Object::new(w)?
            .field("mode", self.mode)?
            .field("rows", &self.rows)?
            .field("bucket_us", &self.bucket_us)?
            .field("t", &self.t)?
            .field_if_some("t_last", &self.t_last)?
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
        return Err(err!("empty window: from must be < to"));
    }

    // Group the requested channels by series so each series costs one scan.
    let mut wanted: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in req.channels {
        let (series, field) = id
            .split_once(':')
            .ok_or_else(|| err!("bad channel id `{id}`, expected `<series>:<field>`"))?;
        let info = db
            .series(series)
            .ok_or_else(|| err!("unknown series `{series}`"))?;
        if !info.channels.iter().any(|c| c.field == field) {
            return Err(err!("unknown channel `{id}`"));
        }
        let fields = wanted.entry(series.to_string()).or_default();
        if !fields.iter().any(|f| f == field) {
            fields.push(field.to_string());
        }
    }

    let fields_per_series: Vec<i64> = wanted.values().map(|f| f.len() as i64).collect();
    let asked_buckets = req.buckets.clamp(1, 20_000);
    let (buckets, max_raw) = budget(req.max_points, &fields_per_series, asked_buckets, req.max_raw);
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

        let rows = conn
            .query_i64(&format!("SELECT count(*) FROM {ident} WHERE {window}"))?
            .unwrap_or(0);

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
            per_channel + sd.t.len() as i64 + sd.t_last.as_ref().map_or(0, |t| t.len() as i64)
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

/// Splits `max_points` across the series of one request, returning the bucket
/// count and the raw threshold that keep the whole response within it.
///
/// Each series is costed as if aggregated -- `4f + 2` values per bucket for `f`
/// channels: min/max/first/last each, plus its two timestamps -- and gets that
/// share of the budget. The bucket count is the same for every series, so their
/// buckets line up. The raw threshold is the largest row count that fits every
/// series' share at `f + 1` values per row. Whichever mode each series then
/// lands in, it stays inside its share, so a response mixing raw and agg series
/// cannot overshoot the way two separately-capped halves would.
fn budget(max_points: i64, fields_per_series: &[i64], buckets: i64, max_raw: i64) -> (i64, i64) {
    let total: i64 = fields_per_series.iter().map(|f| 4 * f + 2).sum::<i64>().max(1);
    let raw_fit = fields_per_series
        .iter()
        .map(|f| max_points * (4 * f + 2) / total / (f + 1))
        .min()
        .unwrap_or(max_points);
    (
        buckets.min((max_points / total).max(1)),
        max_raw.min(raw_fit.max(1)),
    )
}

fn fetch_raw(
    conn: &Connection,
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

    let mut t = Vec::new();
    let mut vals: Vec<Vec<Option<f64>>> = vec![Vec::new(); fields.len()];
    conn.query(&sql)?.for_each_chunk(|chunk| {
        let ts = chunk.i64s(0)?;
        // `ts` is never null in a series orc wrote; a row without one could not
        // be placed on the axis, so it is left out with its values.
        let keep: Vec<usize> = (0..chunk.len()).filter(|&r| ts.get(r).is_some()).collect();
        t.extend(keep.iter().filter_map(|&r| ts.get(r)));
        for (i, col) in vals.iter_mut().enumerate() {
            let v = chunk.f64s(i + 1)?;
            col.extend(keep.iter().map(|&r| v.get(r)));
        }
        Ok(())
    })?;

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
        t_last: None,
        channels,
    })
}

fn fetch_agg(
    conn: &Connection,
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
        "SELECT (epoch_us(ts) - {from}) // {bucket_us} AS b, epoch_us(max(ts)), {} \
         FROM {ident} WHERE {window} GROUP BY b ORDER BY b",
        cols.join(", ")
    );

    let mut t = Vec::new();
    let mut t_last = Vec::new();
    let n = fields.len();
    let mut lo: Vec<Vec<Option<f64>>> = vec![Vec::new(); n];
    let mut hi: Vec<Vec<Option<f64>>> = vec![Vec::new(); n];
    let mut first: Vec<Vec<Option<f64>>> = vec![Vec::new(); n];
    let mut last: Vec<Vec<Option<f64>>> = vec![Vec::new(); n];

    conn.query(&sql)?.for_each_chunk(|chunk| {
        let b = chunk.i64s(0)?;
        let tl = chunk.i64s(1)?;
        // A bucket exists only because it holds a row, so both are set.
        let keep: Vec<usize> = (0..chunk.len())
            .filter(|&r| b.get(r).is_some() && tl.get(r).is_some())
            .collect();
        for &r in &keep {
            t.push(from + b.get(r).unwrap_or(0) * bucket_us);
            t_last.push(tl.get(r).unwrap_or(0));
        }
        for i in 0..n {
            let base = 2 + i * 4;
            let (l, h, f, z) = (
                chunk.f64s(base)?,
                chunk.f64s(base + 1)?,
                chunk.f64s(base + 2)?,
                chunk.f64s(base + 3)?,
            );
            for &r in &keep {
                lo[i].push(l.get(r));
                hi[i].push(h.get(r));
                first[i].push(f.get(r));
                last[i].push(z.get(r));
            }
        }
        Ok(())
    })?;

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
        t_last: Some(t_last),
        channels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a response costs at the worst, given each series' mode.
    fn worst(fields: &[i64], buckets: i64, max_raw: i64, raw: &[bool]) -> i64 {
        fields
            .iter()
            .zip(raw)
            .map(|(f, &r)| if r { max_raw * (f + 1) } else { buckets * (4 * f + 2) })
            .sum()
    }

    #[test]
    fn budget_holds_whatever_mix_of_modes_results() {
        for fields in [&[1][..], &[2], &[1, 1], &[5, 1], &[1, 3, 2], &[20], &[1; 20]] {
            for max_points in [1_000, 250_000, 1_000_000, 4_000_000] {
                let (buckets, max_raw) = budget(max_points, fields, 20_000, 1 << 40);
                for mask in 0..1u32 << fields.len() {
                    let raw: Vec<bool> = (0..fields.len()).map(|i| mask >> i & 1 == 1).collect();
                    let cost = worst(fields, buckets, max_raw, &raw);
                    assert!(cost <= max_points, "{fields:?} {max_points} {raw:?}: {cost}");
                }
            }
        }
    }

    #[test]
    fn budget_leaves_small_asks_alone() {
        assert_eq!(budget(1_000_000, &[2], 1200, 12_000), (1200, 12_000));
        assert_eq!(budget(1_000_000, &[1, 1, 1], 1200, 12_000), (1200, 12_000));
    }
}
