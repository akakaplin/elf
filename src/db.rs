//! Connection handling and catalog discovery.
//!
//! Everything here reads the orc parquet store as it sits on disk. There is no
//! import step and no derived files: each series becomes a DuckDB view over
//! `series/<name>/**/*.parquet`, exactly like the `view.sql` orc writes next to
//! the data, and every query in `query.rs` hits those views directly.

use std::{
    io::{self, Write},
    path::Path,
    sync::Mutex,
};

use crate::coverage::Cache;
use crate::duck::{Connection, Database};
use crate::error::{err, Result};
use crate::json::{Object, ToJson};

const MAX_IDLE: usize = 8;

#[derive(Clone, Debug)]
pub struct Channel {
    /// `<series>:<field>`
    pub id: String,
    pub series: String,
    pub field: String,
    pub dtype: String,
}

impl ToJson for Channel {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        Object::new(w)?
            .field("id", &self.id)?
            .field("series", &self.series)?
            .field("field", &self.field)?
            .field("dtype", &self.dtype)?
            .end()
    }
}

#[derive(Clone, Debug)]
pub struct SeriesInfo {
    pub name: String,
    pub rows: i64,
    pub t_min: Option<i64>,
    pub t_max: Option<i64>,
    pub channels: Vec<Channel>,
}

impl ToJson for SeriesInfo {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        Object::new(w)?
            .field("name", &self.name)?
            .field("rows", &self.rows)?
            .field("t_min", &self.t_min)?
            .field("t_max", &self.t_max)?
            .field("channels", &self.channels)?
            .end()
    }
}

#[derive(Clone, Debug)]
pub struct Catalog {
    pub data_dir: String,
    pub series: Vec<SeriesInfo>,
    pub t_min: Option<i64>,
    pub t_max: Option<i64>,
}

impl Catalog {
    /// Writes the catalog's fields into an object the caller has opened, so a
    /// response can carry fields of its own alongside them.
    pub fn write_fields<'a, W: Write>(&self, obj: Object<'a, W>) -> io::Result<Object<'a, W>> {
        obj.field("data_dir", &self.data_dir)?
            .field("series", &self.series)?
            .field("t_min", &self.t_min)?
            .field("t_max", &self.t_max)
    }
}

pub struct Db {
    // Declared before `database` so the pooled connections close first.
    idle: Mutex<Vec<Connection>>,
    database: Database,
    pub catalog: Catalog,
    /// Each file's coverage, read once; see `coverage.rs`.
    pub coverage: Cache,
}

/// A checked-out connection that returns itself to the pool on drop.
pub struct Lease<'a> {
    conn: Option<Connection>,
    db: &'a Db,
}

impl std::ops::Deref for Lease<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("lease used after drop")
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            let mut idle = self.db.idle.lock().unwrap();
            if idle.len() < MAX_IDLE {
                idle.push(conn);
            }
        }
    }
}

impl Db {
    /// Opens an in-memory DuckDB, defines one view per series directory, and
    /// probes each view for its columns and time bounds.
    pub fn open(data_dir: &Path) -> Result<Self> {
        let data_dir = data_dir
            .canonicalize()
            .map_err(|e| err!("data dir not found: {}: {e}", data_dir.display()))?;
        let series_dir = data_dir.join("series");
        if !series_dir.is_dir() {
            return Err(err!("no series/ directory under {}", data_dir.display()));
        }

        let database = Database::open_in_memory()?;
        let conn = database.connect()?;
        conn.execute("SET TimeZone='UTC';")?;

        let mut names = Vec::new();
        for entry in std::fs::read_dir(&series_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            names.push(name);
        }
        names.sort();

        let mut series = Vec::new();
        for name in names {
            let glob = series_dir.join(&name).join("**").join("*.parquet");
            let sql = format!(
                "CREATE OR REPLACE VIEW {} AS SELECT * FROM read_parquet('{}', hive_partitioning = 1, union_by_name = 1)",
                quote_ident(&name),
                escape_literal(&glob.to_string_lossy()),
            );
            if let Err(e) = conn.execute(&sql) {
                eprintln!("skipping series {name}: {e}");
                continue;
            }
            match describe(&conn, &name) {
                Ok(info) => series.push(info),
                Err(e) => eprintln!("skipping series {name}: {e}"),
            }
        }

        if series.is_empty() {
            return Err(err!("no readable series under {}", series_dir.display()));
        }

        let t_min = series.iter().filter_map(|s| s.t_min).min();
        let t_max = series.iter().filter_map(|s| s.t_max).max();

        Ok(Db {
            // The connection that built the views is the pool's first.
            idle: Mutex::new(vec![conn]),
            database,
            coverage: Cache::new(&data_dir),
            catalog: Catalog {
                data_dir: data_dir.to_string_lossy().into_owned(),
                series,
                t_min,
                t_max,
            },
        })
    }

    pub fn lease(&self) -> Result<Lease<'_>> {
        if let Some(conn) = self.idle.lock().unwrap().pop() {
            return Ok(Lease {
                conn: Some(conn),
                db: self,
            });
        }
        // Every connection shares the one in-memory database, so the views and
        // DuckDB's parquet metadata cache are shared across the pool.
        let conn = self.database.connect()?;
        conn.execute("SET TimeZone='UTC';")?;
        Ok(Lease {
            conn: Some(conn),
            db: self,
        })
    }

    pub fn series(&self, name: &str) -> Option<&SeriesInfo> {
        self.catalog.series.iter().find(|s| s.name == name)
    }
}

fn describe(conn: &Connection, name: &str) -> Result<SeriesInfo> {
    let ident = quote_ident(name);

    let mut cols: Vec<(String, String)> = Vec::new();
    conn.query(&format!("DESCRIBE {ident}"))?
        .for_each_chunk(|chunk| {
            for r in 0..chunk.len() {
                if let (Some(name), Some(ty)) = (chunk.string(0, r)?, chunk.string(1, r)?) {
                    cols.push((name, ty));
                }
            }
            Ok(())
        })?;

    let channels = cols
        .iter()
        .filter(|(col, ty)| col != "ts" && is_numeric(ty))
        .map(|(col, ty)| Channel {
            id: format!("{name}:{col}"),
            series: name.to_string(),
            field: col.clone(),
            dtype: ty.clone(),
        })
        .collect();

    let mut result = conn.query(&format!(
        "SELECT count(*), epoch_us(min(ts)), epoch_us(max(ts)) FROM {ident}"
    ))?;
    let chunk = result.next_chunk().ok_or_else(|| err!("no row from {ident}"))?;
    let (rows, t_min, t_max) = (
        chunk.i64s(0)?.get(0).unwrap_or(0),
        chunk.i64s(1)?.get(0),
        chunk.i64s(2)?.get(0),
    );

    Ok(SeriesInfo {
        name: name.to_string(),
        rows,
        t_min,
        t_max,
        channels,
    })
}

fn is_numeric(ty: &str) -> bool {
    let ty = ty.to_ascii_uppercase();
    ty.starts_with("DECIMAL")
        || matches!(
            ty.as_str(),
            "DOUBLE"
                | "FLOAT"
                | "REAL"
                | "TINYINT"
                | "SMALLINT"
                | "INTEGER"
                | "BIGINT"
                | "HUGEINT"
                | "UTINYINT"
                | "USMALLINT"
                | "UINTEGER"
                | "UBIGINT"
                | "UHUGEINT"
        )
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn escape_literal(s: &str) -> String {
    s.replace('\'', "''")
}
