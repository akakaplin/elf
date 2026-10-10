//! elf -- a multi-channel viewer for an orc parquet time-series store.
//!
//! The server holds no state beyond DuckDB views over the parquet files. Every
//! request reads the raw store; aggregation, when the window is too dense to
//! draw point-for-point, happens inside the query and never touches disk.

mod coverage;
mod db;
mod duck;
mod error;
mod http;
mod json;
mod query;

use std::{
    ffi::OsString,
    io::{self, Write},
    net::{SocketAddr, TcpListener},
    panic::{self, AssertUnwindSafe},
    path::PathBuf,
    process,
    sync::Arc,
    thread,
    time::Instant,
};

use crate::db::{Catalog, Db};
use crate::error::{err, Result};
use crate::http::{Request, Response};
use crate::json::{Field, Object, ToJson};

/// The page chooses its own memory budget and sends it with each request; these
/// are the bounds it has to choose within. The ceiling is deliberately not
/// configurable — it is the point past which a response stops being something a
/// browser can hold, not a matter of taste.
const MAX_POINTS_CEILING: i64 = 4_000_000;
const MAX_POINTS_FLOOR: i64 = 2_000;
const DEFAULT_MAX_POINTS: i64 = 1_000_000;
/// Bounds on the coverage probe's resolution. The floor keeps the span count
/// near the store's length in seconds; the ceiling (a week) only keeps the
/// conversion to microseconds from overflowing.
const MIN_COVERAGE_BUCKET_MS: i64 = 1_000;
const MAX_COVERAGE_BUCKET_MS: i64 = 7 * 24 * 3_600_000;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Most values one `/api/data` response may ever materialise.
    pub max_points_ceiling: i64,
    /// Least budget one `/api/data` request is given, whatever it asks for. The
    /// page needs it to split a viewport's budget without going under it.
    pub min_points: i64,
    /// What a request gets if it names no budget of its own.
    pub default_max_points: i64,
    /// Channels one request may name.
    pub max_channels: usize,
}

impl ToJson for Limits {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        Object::new(w)?
            .field("max_points_ceiling", &self.max_points_ceiling)?
            .field("min_points", &self.min_points)?
            .field("default_max_points", &self.default_max_points)?
            .field("max_channels", &self.max_channels)?
            .end()
    }
}

// --------------------------------------------------------------------- cli ---

const DEFAULT_WEB: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/web");

const USAGE: &str = "Usage: elf [OPTIONS] --data <DATA>";

const HELP: &str = concat!(
    "Multi-channel viewer over a raw parquet time-series store\n",
    "\n",
    "Usage: elf [OPTIONS] --data <DATA>\n",
    "\n",
    "Options:\n",
    "      --data <DATA>                  orc data directory (the one holding manifest.json and series/)\n",
    "      --web <WEB>                    Static assets to serve [default: ",
    env!("CARGO_MANIFEST_DIR"),
    "/web]\n",
    "      --host <HOST>                  [default: 127.0.0.1]\n",
    "      --port <PORT>                  [default: 8787]\n",
    "      --max-channels <MAX_CHANNELS>  Channels a single request may name [default: 20]\n",
    "  -h, --help                         Print help\n",
    "  -V, --version                      Print version\n",
);

#[derive(Debug)]
struct Args {
    /// orc data directory (the one holding manifest.json and series/)
    data: PathBuf,
    /// Static assets to serve
    web: PathBuf,
    host: String,
    port: u16,
    /// Channels a single request may name.
    max_channels: usize,
}

#[derive(Debug)]
enum Parsed {
    Run(Args),
    Help,
    Version,
}

impl Args {
    /// Reads the command line. Help, the version and usage errors are printed
    /// here, and the process exits.
    fn parse() -> Args {
        match parse_args(std::env::args_os().skip(1)) {
            Ok(Parsed::Run(args)) => args,
            Ok(Parsed::Help) => {
                print!("{HELP}");
                process::exit(0)
            }
            Ok(Parsed::Version) => {
                println!("elf {}", env!("CARGO_PKG_VERSION"));
                process::exit(0)
            }
            Err(msg) => {
                eprintln!("error: {msg}\n\n{USAGE}\n\nFor more information, try '--help'.");
                process::exit(2)
            }
        }
    }
}

/// Takes both `--flag value` and `--flag=value`. A value may not start with
/// `-`, so a forgotten value is reported instead of swallowing the next flag.
fn parse_args(argv: impl IntoIterator<Item = OsString>) -> Result<Parsed, String> {
    let mut data = None;
    let mut web = PathBuf::from(DEFAULT_WEB);
    let mut host = "127.0.0.1".to_string();
    let mut port = 8787;
    let mut max_channels = 20;

    let mut argv = argv.into_iter();
    while let Some(raw) = argv.next() {
        let raw = raw.to_string_lossy().into_owned();
        let (flag, mut inline) = match raw.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => {
                (flag.to_string(), Some(OsString::from(value)))
            }
            _ => (raw, None),
        };
        let mut value = || match inline.take().or_else(|| argv.next()) {
            Some(v) if !v.to_string_lossy().starts_with('-') => Ok(v),
            _ => Err(format!("a value is required for '{flag}' but none was supplied")),
        };
        match flag.as_str() {
            "-h" | "--help" => return Ok(Parsed::Help),
            "-V" | "--version" => return Ok(Parsed::Version),
            "--data" => data = Some(PathBuf::from(value()?)),
            "--web" => web = PathBuf::from(value()?),
            "--host" => host = value()?.to_string_lossy().into_owned(),
            "--port" => port = number(&flag, value()?)?,
            "--max-channels" => max_channels = number(&flag, value()?)?,
            _ => return Err(format!("unexpected argument '{flag}' found")),
        }
    }

    let data = data.ok_or("the following required arguments were not provided:\n  --data <DATA>")?;
    Ok(Parsed::Run(Args {
        data,
        web,
        host,
        port,
        max_channels,
    }))
}

fn number<T>(flag: &str, value: OsString) -> Result<T, String>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let value = value.to_string_lossy();
    value
        .parse()
        .map_err(|e| format!("invalid value '{value}' for '{flag}': {e}"))
}

fn main() -> Result<()> {
    let args = Args::parse();

    eprintln!("elf: opening {}", args.data.display());
    let db = Db::open(&args.data)?;
    for s in &db.catalog.series {
        eprintln!(
            "  {:<22} {:>9} rows  {:>2} channels",
            s.name,
            s.rows,
            s.channels.len()
        );
    }

    let limits = Limits {
        max_points_ceiling: MAX_POINTS_CEILING,
        min_points: MAX_POINTS_FLOOR,
        default_max_points: DEFAULT_MAX_POINTS,
        max_channels: args.max_channels.max(1),
    };
    eprintln!(
        "  limits: up to {} points/response, {} channels/request",
        limits.max_points_ceiling, limits.max_channels
    );

    let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
    let listener = TcpListener::bind(addr)?;
    eprintln!("elf: http://{addr}");
    let app = Arc::new(App {
        db,
        limits,
        web: args.web,
    });
    // Read every file's coverage now rather than on the page's first load,
    // while the server already answers. A request arriving first waits on the
    // same lock and gets the finished answer.
    let warm = Arc::clone(&app);
    thread::Builder::new()
        .name("elf-coverage".into())
        .spawn(move || {
            let started = Instant::now();
            match warm.db.coverage.warm(&warm.db) {
                Ok(()) => eprintln!("elf: coverage read in {:.1?}", started.elapsed()),
                Err(e) => eprintln!("elf: coverage warm-up failed: {e}"),
            }
        })?;
    http::serve(listener, move |req| app.route(req))
}

// ------------------------------------------------------------------ routes --

struct App {
    db: Db,
    limits: Limits,
    web: PathBuf,
}

impl App {
    fn route(&self, req: &Request) -> Response {
        match req.path.as_str() {
            "/api/health" => health(),
            "/api/catalog" => self.catalog(),
            "/api/coverage" => api(|| self.coverage(req)),
            "/api/data" => api(|| self.data(req)),
            path => http::static_file(&self.web, path),
        }
    }

    fn catalog(&self) -> Response {
        Response::json(
            200,
            CatalogResponse {
                catalog: self.db.catalog.clone(),
                limits: self.limits,
            },
        )
    }

    fn coverage(&self, req: &Request) -> Result<query::Coverage> {
        // Resolution at which occupancy is probed. Smaller finds smaller gaps,
        // and costs a span per bucket at worst, so it has a floor: below it one
        // dense series alone answers with millions of spans.
        let bucket_ms = param(req, "bucket_ms")?.unwrap_or(60_000);
        // Per-series gaps this short are joined. The lanes those spans draw
        // are a strip of pixels across the whole store, where a feed that
        // prints every few seconds is otherwise a span per bucket -- 83,000 of
        // them, 3 MB, for lines nobody can tell apart. The union, which the
        // axis collapses gaps against, is never merged.
        let merge_ms = param(req, "merge_ms")?.unwrap_or(0);
        self.db.coverage.coverage(
            &self.db,
            bucket_ms.clamp(MIN_COVERAGE_BUCKET_MS, MAX_COVERAGE_BUCKET_MS) * 1_000,
            merge_ms.clamp(0, MAX_COVERAGE_BUCKET_MS) * 1_000,
        )
    }

    fn data(&self, req: &Request) -> Result<query::DataResponse> {
        // Window start (inclusive) and end (exclusive), epoch micros.
        let from = param(req, "from")?.ok_or_else(|| missing("from"))?;
        let to = param(req, "to")?.ok_or_else(|| missing("to"))?;
        let buckets = param(req, "buckets")?.unwrap_or(1200);
        let max_raw = param(req, "max_raw")?.unwrap_or(12_000);
        // Values this response may materialise. The page sets it; the server
        // clamps it to something it is willing to build.
        let max_points = param(req, "max_points")?.unwrap_or(DEFAULT_MAX_POINTS);

        // Comma-separated `<series>:<field>` ids.
        let channels: Vec<String> = req
            .param("channels")
            .ok_or_else(|| missing("channels"))?
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        if channels.is_empty() {
            return Err(err!("no channels requested"));
        }
        if channels.len() > self.limits.max_channels {
            return Err(err!(
                "at most {} channels per request, got {}",
                self.limits.max_channels,
                channels.len()
            ));
        }

        query::data(
            &self.db,
            &query::DataRequest {
                from,
                to,
                buckets,
                max_raw: max_raw.max(0),
                max_points: max_points.clamp(MAX_POINTS_FLOOR, MAX_POINTS_CEILING),
                channels: &channels,
            },
        )
    }
}

/// A heartbeat the page polls to tell "server gone" from "nothing to ask for".
/// Deliberately touches no state: it answers while a heavy query is in flight,
/// so the indicator reports reachability rather than load.
fn health() -> Response {
    Response::json(200, Field("ok", true))
}

struct CatalogResponse {
    catalog: Catalog,
    limits: Limits,
}

impl ToJson for CatalogResponse {
    /// The catalog's own fields, with `limits` alongside them.
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        self.catalog
            .write_fields(Object::new(w)?)?
            .field("limits", &self.limits)?
            .end()
    }
}

// ------------------------------------------------------------------- glue ---

/// Runs an API handler and answers with its result, or with the
/// `{"error": ...}` body the page shows. A panic is reported the same way
/// rather than dropping the connection without a word.
fn api<T: ToJson + 'static>(handler: impl FnOnce() -> Result<T>) -> Response {
    let outcome = panic::catch_unwind(AssertUnwindSafe(handler)).unwrap_or_else(|payload| {
        let msg = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("unknown cause");
        Err(err!("task panicked: {msg}"))
    });
    match outcome {
        Ok(value) => Response::json(200, value),
        Err(e) => Response::json(400, Field("error", e.to_string())),
    }
}

/// An integer query parameter. One that is present but not a number is an
/// error, not a quiet fallback to the default.
fn param(req: &Request, key: &str) -> Result<Option<i64>> {
    req.param(key)
        .map(|v| v.parse().map_err(|e| err!("invalid `{key}` value `{v}`: {e}")))
        .transpose()
}

fn missing(key: &str) -> error::Error {
    err!("missing query parameter `{key}`")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(argv: &[&str]) -> Result<Parsed, String> {
        parse_args(argv.iter().map(OsString::from))
    }

    #[test]
    fn flags_take_values_either_way_and_default_the_rest() {
        let Ok(Parsed::Run(args)) = parse(&["--data", "/d", "--port=9000", "--max-channels", "3"]) else {
            panic!("did not parse");
        };
        assert_eq!(args.data, PathBuf::from("/d"));
        assert_eq!(args.port, 9000);
        assert_eq!(args.max_channels, 3);
        assert_eq!(args.host, "127.0.0.1");
        assert_eq!(args.web, PathBuf::from(DEFAULT_WEB));
    }

    #[test]
    fn help_and_version_need_no_data_dir() {
        assert!(matches!(parse(&["--help"]), Ok(Parsed::Help)));
        assert!(matches!(parse(&["-h"]), Ok(Parsed::Help)));
        assert!(matches!(parse(&["-V"]), Ok(Parsed::Version)));
    }

    #[test]
    fn bad_command_lines_are_errors() {
        assert!(parse(&[]).unwrap_err().contains("--data"));
        for argv in [
            &["--data"][..],
            &["--data", "--port", "1"],
            &["--data", "x", "--port", "abc"],
            &["--data", "x", "--port", "70000"],
            &["--data", "x", "--bogus"],
            &["stray"],
        ] {
            assert!(parse(argv).is_err(), "{argv:?}");
        }
    }
}
