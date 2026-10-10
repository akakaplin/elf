//! Which stretches of time hold data, kept per file so a request reads only
//! what changed since the last one.
//!
//! Answering from scratch means decoding `ts` from every file in the store --
//! 70,000 small ones after a few days, ten seconds a call, almost all of it
//! spent opening files rather than reading rows. But a data file never changes
//! once it is there: orc renames a finished file into `series/` whole, and a
//! re-run of a flush writes a new name rather than rewriting the old. So each
//! file's coverage is worked out once, as spans of whole seconds, and kept. A
//! request lists the directory, forgets files that are gone (`perpl cleanup`
//! deletes some), reads only the new ones -- one flush's worth is ~190 files
//! and ~20 ms -- and builds the answer from memory at whatever bucket size was
//! asked for.
//!
//! Spans are kept at one-second resolution, the floor `bucket_ms` is clamped
//! to, so any bucket size the API accepts can be derived from them. For a
//! bucket that is a whole number of seconds the answer is exactly what bucketing
//! the raw rows gives; for any other a second split by a bucket edge marks both
//! buckets, a sliver more than the rows alone would.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::db::{escape_literal, Db};
use crate::error::Result;
use crate::query::Coverage;

/// Files read per query when filling the cache. Bounds the SQL text, which
/// names every file, and how much one query holds at once.
const BATCH: usize = 2_000;

const US_PER_S: i64 = 1_000_000;

/// One file's occupied seconds, as inclusive `[first, last]` runs.
struct FileCoverage {
    series: String,
    spans: Vec<[i64; 2]>,
}

pub struct Cache {
    series_dir: PathBuf,
    /// Keyed by the path exactly as it is handed to DuckDB, which is also how
    /// DuckDB reports it back in `filename`.
    files: Mutex<HashMap<String, FileCoverage>>,
}

impl Cache {
    pub fn new(data_dir: &Path) -> Cache {
        Cache {
            series_dir: data_dir.join("series"),
            files: Mutex::new(HashMap::new()),
        }
    }

    /// Coverage of the catalog's series at `bucket_us`. Per-series spans whose
    /// gap is `merge_us` or less are joined; the union is never merged, because
    /// the time axis collapses exactly the gaps it shows.
    pub fn coverage(&self, db: &Db, bucket_us: i64, merge_us: i64) -> Result<Coverage> {
        let bucket_us = bucket_us.max(1);
        let mut files = self.files.lock().unwrap_or_else(|p| p.into_inner());
        self.refresh(db, &mut files)?;

        let mut per_series: BTreeMap<&str, Vec<[i64; 2]>> = db
            .catalog
            .series
            .iter()
            .map(|s| (s.name.as_str(), Vec::new()))
            .collect();
        for file in files.values() {
            if let Some(spans) = per_series.get_mut(file.series.as_str()) {
                spans.extend(file.spans.iter().map(|&s| to_buckets(s, bucket_us)));
            }
        }

        let mut all = Vec::new();
        let mut series = BTreeMap::new();
        for (name, mut spans) in per_series {
            spans.sort_unstable();
            let spans = merge(spans, 0);
            all.extend_from_slice(&spans);
            series.insert(name.to_string(), merge(spans, merge_us));
        }
        all.sort_unstable();

        Ok(Coverage {
            bucket_us,
            series,
            union: merge(all, 0),
        })
    }

    /// Fills the cache ahead of the first request, so the page's first load
    /// does not pay for reading the whole store.
    pub fn warm(&self, db: &Db) -> Result<()> {
        let mut files = self.files.lock().unwrap_or_else(|p| p.into_inner());
        self.refresh(db, &mut files)
    }

    /// Brings the cache in line with what is on disk.
    fn refresh(&self, db: &Db, files: &mut HashMap<String, FileCoverage>) -> Result<()> {
        let mut on_disk = Vec::new();
        for series in &db.catalog.series {
            collect_parquet(&self.series_dir.join(&series.name), &series.name, &mut on_disk);
        }

        let present: HashSet<&str> = on_disk.iter().map(|(path, _)| path.as_str()).collect();
        files.retain(|path, _| present.contains(path.as_str()));

        let new: Vec<(String, String)> = on_disk
            .into_iter()
            .filter(|(path, _)| !files.contains_key(path))
            .collect();
        for batch in new.chunks(BATCH) {
            read_batch(db, batch, files)?;
        }
        Ok(())
    }
}

/// Every `*.parquet` under `dir`, at any depth, paired with its series. A
/// directory that cannot be listed is skipped: the series it belongs to then
/// shows less coverage, which is better than none at all.
fn collect_parquet(dir: &Path, series: &str, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => collect_parquet(&path, series, out),
            Ok(_) if path.extension().is_some_and(|e| e == "parquet") => {
                out.push((path.to_string_lossy().into_owned(), series.to_string()));
            }
            _ => {}
        }
    }
}

/// Reads one batch of new files into the cache. If the batch will not read --
/// one bad file fails the whole query -- each file is tried alone, and one that
/// still fails is logged and cached as empty rather than retried every call.
fn read_batch(
    db: &Db,
    batch: &[(String, String)],
    files: &mut HashMap<String, FileCoverage>,
) -> Result<()> {
    match spans_of(db, batch) {
        Ok(found) => {
            store(batch, found, files);
            Ok(())
        }
        Err(_) if batch.len() > 1 => {
            for file in batch {
                read_batch(db, std::slice::from_ref(file), files)?;
            }
            Ok(())
        }
        Err(e) => {
            eprintln!("elf: coverage: skipping {}: {e}", batch[0].0);
            store(batch, HashMap::new(), files);
            Ok(())
        }
    }
}

/// Every file in the batch goes into the cache, an empty one included, so it
/// is not read again on the next call.
fn store(
    batch: &[(String, String)],
    mut found: HashMap<String, Vec<[i64; 2]>>,
    files: &mut HashMap<String, FileCoverage>,
) {
    for (path, series) in batch {
        let spans = found.remove(path).unwrap_or_default();
        files.insert(
            path.clone(),
            FileCoverage {
                series: series.clone(),
                spans,
            },
        );
    }
}

/// Each file's occupied seconds as runs, computed in one query: distinct
/// seconds per file, then the gaps-and-islands trick -- a second minus its rank
/// is constant along a run of consecutive seconds -- so what comes back is
/// already a handful of spans rather than a row per second.
fn spans_of(db: &Db, batch: &[(String, String)]) -> Result<HashMap<String, Vec<[i64; 2]>>> {
    let list: Vec<String> = batch
        .iter()
        .map(|(path, _)| format!("'{}'", escape_literal(path)))
        .collect();
    let sql = format!(
        "SELECT filename, min(s), max(s) FROM ( \
           SELECT filename, s, s - row_number() OVER (PARTITION BY filename ORDER BY s) AS run \
           FROM (SELECT DISTINCT filename, epoch_us(ts) // {US_PER_S} AS s \
                 FROM read_parquet([{}], filename = true, union_by_name = true, \
                                   hive_partitioning = false))) \
         GROUP BY filename, run",
        list.join(", ")
    );

    let conn = db.lease()?;
    let mut out: HashMap<String, Vec<[i64; 2]>> = HashMap::new();
    conn.query(&sql)?.for_each_chunk(|chunk| {
        let first = chunk.i64s(1)?;
        let last = chunk.i64s(2)?;
        for r in 0..chunk.len() {
            if let (Some(path), Some(a), Some(b)) = (chunk.string(0, r)?, first.get(r), last.get(r)) {
                out.entry(path).or_default().push([a, b]);
            }
        }
        Ok(())
    })?;
    Ok(out)
}

/// Inclusive seconds to the half-open microsecond span of the buckets they
/// touch.
fn to_buckets([first, last]: [i64; 2], bucket_us: i64) -> [i64; 2] {
    let lo = (first * US_PER_S).div_euclid(bucket_us);
    let hi = (last * US_PER_S + US_PER_S - 1).div_euclid(bucket_us);
    [lo * bucket_us, (hi + 1) * bucket_us]
}

/// Sorted half-open spans, joined where the gap between them is `gap_us` or
/// less -- zero joins only those that touch or overlap.
fn merge(sorted: Vec<[i64; 2]>, gap_us: i64) -> Vec<[i64; 2]> {
    let mut out: Vec<[i64; 2]> = Vec::with_capacity(sorted.len());
    for [a, b] in sorted {
        match out.last_mut() {
            Some(last) if a - last[1] <= gap_us => last[1] = last[1].max(b),
            _ => out.push([a, b]),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seconds_widen_to_the_buckets_they_touch() {
        // 15 s buckets: seconds 14..=15 straddle the edge at 15.
        assert_eq!(to_buckets([14, 15], 15 * US_PER_S), [0, 30 * US_PER_S]);
        assert_eq!(to_buckets([15, 29], 15 * US_PER_S), [15 * US_PER_S, 30 * US_PER_S]);
        // A bucket smaller than a second still covers the whole second.
        assert_eq!(to_buckets([3, 3], 250_000), [3 * US_PER_S, 4 * US_PER_S]);
    }

    #[test]
    fn spans_join_when_they_touch_or_the_gap_is_small() {
        let s = vec![[0, 10], [10, 20], [25, 30], [100, 110]];
        assert_eq!(merge(s.clone(), 0), vec![[0, 20], [25, 30], [100, 110]]);
        assert_eq!(merge(s.clone(), 5), vec![[0, 30], [100, 110]]);
        assert_eq!(merge(s, 1_000), vec![[0, 110]]);
        // An overlap must not shrink the span it lands inside.
        assert_eq!(merge(vec![[0, 50], [10, 20]], 0), vec![[0, 50]]);
    }
}
