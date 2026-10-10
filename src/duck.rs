//! The slice of DuckDB's C API this server uses, behind a safe face.
//!
//! The `duckdb` crate is a full client — prepared statements, an Arrow bridge,
//! an appender, table printing — and pulls in about a hundred crates for it,
//! Arrow alone being most of them. Every query here is SQL text returning
//! BIGINT, DOUBLE or VARCHAR columns, read once, front to back. That is a
//! connection, `duckdb_query`, and a walk over the result's data chunks, so
//! this talks to `libduckdb-sys` directly, which links the library and brings
//! no runtime dependencies of its own.
//!
//! What the wrappers guarantee: every handle is released exactly once, a
//! column is read only as the type DuckDB says it has, and nothing borrowed
//! from a chunk outlives it.

use libduckdb_sys as ffi;
use std::ffi::{CStr, CString};
use std::fmt;
use std::ptr;

#[derive(Debug)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// An open database. Connections borrow nothing from it at the type level --
/// DuckDB keeps the instance alive for as long as any connection to it is
/// open -- but it should still be dropped last.
pub struct Database(ffi::duckdb_database);

// DuckDB's database object is thread-safe: connecting to it from several
// threads at once is how it is meant to be used.
unsafe impl Send for Database {}
unsafe impl Sync for Database {}

impl Database {
    pub fn open_in_memory() -> Result<Database> {
        let mut db = ptr::null_mut();
        // A null path is an in-memory database.
        if unsafe { ffi::duckdb_open(ptr::null(), &mut db) } != ffi::duckdb_state_DuckDBSuccess {
            return Err(Error("cannot open an in-memory DuckDB database".into()));
        }
        Ok(Database(db))
    }

    /// A new connection. Every connection to one database shares its catalog --
    /// the views -- and its caches.
    pub fn connect(&self) -> Result<Connection> {
        let mut conn = ptr::null_mut();
        if unsafe { ffi::duckdb_connect(self.0, &mut conn) } != ffi::duckdb_state_DuckDBSuccess {
            return Err(Error("cannot connect to the DuckDB database".into()));
        }
        Ok(Connection(conn))
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_close(&mut self.0) }
    }
}

/// One connection: used by one thread at a time, and moved between them.
pub struct Connection(ffi::duckdb_connection);

// A connection may move between threads; it is never shared, which is why
// this is `Send` and not `Sync`.
unsafe impl Send for Connection {}

impl Connection {
    /// Runs SQL for its effect, discarding any result.
    pub fn execute(&self, sql: &str) -> Result<()> {
        self.query(sql).map(drop)
    }

    /// Runs SQL and returns its whole result.
    pub fn query(&self, sql: &str) -> Result<Rows> {
        let text = CString::new(sql).map_err(|_| Error("SQL contains a NUL byte".into()))?;
        // Zeroed is the documented "empty" state; `duckdb_destroy_result` is
        // safe on it and is owed on the failure path too.
        let mut result: ffi::duckdb_result = unsafe { std::mem::zeroed() };
        let state = unsafe { ffi::duckdb_query(self.0, text.as_ptr(), &mut result) };
        let rows = Rows(result);
        if state != ffi::duckdb_state_DuckDBSuccess {
            let mut rows = rows;
            let msg = unsafe { ffi::duckdb_result_error(&mut rows.0) };
            let msg = if msg.is_null() {
                "query failed".to_string()
            } else {
                unsafe { CStr::from_ptr(msg) }.to_string_lossy().into_owned()
            };
            return Err(Error(msg));
        }
        Ok(rows)
    }

    /// The first row's first column, which must be a BIGINT -- `count(*)`.
    pub fn query_i64(&self, sql: &str) -> Result<Option<i64>> {
        let mut rows = self.query(sql)?;
        let Some(chunk) = rows.next_chunk() else {
            return Err(Error("query returned no rows".into()));
        };
        Ok(chunk.i64s(0)?.get(0))
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_disconnect(&mut self.0) }
    }
}

/// A query's result, read one chunk -- up to 2,048 rows -- at a time.
pub struct Rows(ffi::duckdb_result);

impl Rows {
    pub fn column_count(&mut self) -> usize {
        unsafe { ffi::duckdb_column_count(&mut self.0) as usize }
    }

    fn column_type(&mut self, col: usize) -> ffi::duckdb_type {
        unsafe { ffi::duckdb_column_type(&mut self.0, col as ffi::idx_t) }
    }

    /// The next chunk, or `None` once the result is spent.
    pub fn next_chunk(&mut self) -> Option<Chunk<'_>> {
        let types: Vec<ffi::duckdb_type> = (0..self.column_count())
            .map(|c| self.column_type(c))
            .collect();
        // `duckdb_fetch_chunk` takes the result struct by value but reads
        // through its internal pointer, so the copy shares our state.
        let chunk = unsafe { ffi::duckdb_fetch_chunk(self.0) };
        if chunk.is_null() {
            return None;
        }
        let len = unsafe { ffi::duckdb_data_chunk_get_size(chunk) } as usize;
        if len == 0 {
            let mut chunk = chunk;
            unsafe { ffi::duckdb_destroy_data_chunk(&mut chunk) };
            return None;
        }
        Some(Chunk {
            chunk,
            len,
            types,
            _rows: std::marker::PhantomData,
        })
    }

    /// Every chunk in turn, handed to `f`.
    pub fn for_each_chunk(&mut self, mut f: impl FnMut(&Chunk) -> Result<()>) -> Result<()> {
        while let Some(chunk) = self.next_chunk() {
            f(&chunk)?;
        }
        Ok(())
    }
}

impl Drop for Rows {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_destroy_result(&mut self.0) }
    }
}

/// One chunk of a result. Columns are read through typed views that check the
/// column really has that type.
pub struct Chunk<'a> {
    chunk: ffi::duckdb_data_chunk,
    len: usize,
    types: Vec<ffi::duckdb_type>,
    _rows: std::marker::PhantomData<&'a mut Rows>,
}

impl Chunk<'_> {
    pub fn len(&self) -> usize {
        self.len
    }

    fn column<T: Copy>(&self, col: usize, want: ffi::duckdb_type, name: &str) -> Result<Column<'_, T>> {
        match self.types.get(col) {
            Some(&t) if t == want => {}
            Some(&t) => return Err(Error(format!("column {col} is DuckDB type {t}, not {name}"))),
            None => return Err(Error(format!("no column {col}"))),
        }
        let vector = unsafe { ffi::duckdb_data_chunk_get_vector(self.chunk, col as ffi::idx_t) };
        let data = unsafe { ffi::duckdb_vector_get_data(vector) } as *const T;
        let validity = unsafe { ffi::duckdb_vector_get_validity(vector) };
        Ok(Column {
            data: unsafe { std::slice::from_raw_parts(data, self.len) },
            validity: if validity.is_null() {
                None
            } else {
                Some(unsafe { std::slice::from_raw_parts(validity, self.len.div_ceil(64)) })
            },
        })
    }

    pub fn i64s(&self, col: usize) -> Result<Column<'_, i64>> {
        self.column(col, ffi::DUCKDB_TYPE_DUCKDB_TYPE_BIGINT, "BIGINT")
    }

    pub fn f64s(&self, col: usize) -> Result<Column<'_, f64>> {
        self.column(col, ffi::DUCKDB_TYPE_DUCKDB_TYPE_DOUBLE, "DOUBLE")
    }

    /// A VARCHAR value, copied out; `None` for a null.
    pub fn string(&self, col: usize, row: usize) -> Result<Option<String>> {
        let column = self.column::<ffi::duckdb_string_t>(col, ffi::DUCKDB_TYPE_DUCKDB_TYPE_VARCHAR, "VARCHAR")?;
        let Some(mut s) = column.get(row) else {
            return Ok(None);
        };
        let len = unsafe { ffi::duckdb_string_t_length(s) } as usize;
        let data = unsafe { ffi::duckdb_string_t_data(&mut s) } as *const u8;
        let bytes = unsafe { std::slice::from_raw_parts(data, len) };
        Ok(Some(String::from_utf8_lossy(bytes).into_owned()))
    }
}

impl Drop for Chunk<'_> {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_destroy_data_chunk(&mut self.chunk) }
    }
}

/// One column of a chunk, as values and a validity mask.
pub struct Column<'a, T> {
    data: &'a [T],
    /// One bit a row, set when the value is present; `None` when every row is.
    validity: Option<&'a [u64]>,
}

impl<T: Copy> Column<'_, T> {
    /// The value at `row`, or `None` for a null or a row past the end.
    pub fn get(&self, row: usize) -> Option<T> {
        let value = *self.data.get(row)?;
        match self.validity {
            Some(mask) if mask[row / 64] & (1 << (row % 64)) == 0 => None,
            _ => Some(value),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_type_with_nulls_across_chunks() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.connect().unwrap();
        // 5,000 rows: three chunks, so the walk has to carry on past the first.
        let mut rows = conn
            .query(
                "SELECT i::BIGINT AS a,
                        CASE WHEN i % 3 = 0 THEN NULL ELSE i / 2 END::DOUBLE AS b,
                        CASE WHEN i % 5 = 0 THEN NULL ELSE 'row ' || i || ' of a longer string' END AS c
                 FROM range(5000) t(i) ORDER BY i",
            )
            .unwrap();
        assert_eq!(rows.column_count(), 3);
        let mut seen = 0usize;
        rows.for_each_chunk(|chunk| {
            let a = chunk.i64s(0)?;
            let b = chunk.f64s(1)?;
            for r in 0..chunk.len() {
                let i = a.get(r).unwrap();
                assert_eq!(i, seen as i64);
                assert_eq!(b.get(r), (i % 3 != 0).then_some(i as f64 / 2.0));
                let c = chunk.string(2, r)?;
                assert_eq!(c, (i % 5 != 0).then(|| format!("row {i} of a longer string")));
                seen += 1;
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, 5000);
    }

    #[test]
    fn short_strings_are_read_inline() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.connect().unwrap();
        // Each branch of a UNION can arrive as its own chunk, so read them all.
        let mut rows = conn.query("SELECT 'ts' UNION ALL SELECT ''").unwrap();
        let mut got = Vec::new();
        rows.for_each_chunk(|chunk| {
            for r in 0..chunk.len() {
                got.push(chunk.string(0, r)?);
            }
            Ok(())
        })
        .unwrap();
        got.sort();
        assert_eq!(got, vec![Some(String::new()), Some("ts".to_string())]);
    }

    #[test]
    fn wrong_types_and_bad_sql_are_errors_not_garbage() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.connect().unwrap();
        let mut rows = conn.query("SELECT 1.5::DOUBLE").unwrap();
        let chunk = rows.next_chunk().unwrap();
        assert!(chunk.i64s(0).is_err());
        assert!(chunk.f64s(0).is_ok());
        drop(chunk);
        let err = conn.query("SELECT * FROM nowhere").err().unwrap();
        assert!(err.to_string().contains("nowhere"), "{err}");
        assert_eq!(conn.query_i64("SELECT count(*) FROM range(7)").unwrap(), Some(7));
    }

    #[test]
    fn connections_share_the_catalog() {
        let db = Database::open_in_memory().unwrap();
        let a = db.connect().unwrap();
        a.execute("CREATE VIEW v AS SELECT 42::BIGINT AS x").unwrap();
        let b = db.connect().unwrap();
        assert_eq!(b.query_i64("SELECT x FROM v").unwrap(), Some(42));
    }
}
