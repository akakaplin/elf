//! elf -- a multi-channel viewer for an orc parquet time-series store.
//!
//! The server holds no state beyond DuckDB views over the parquet files. Every
//! request reads the raw store; aggregation, when the window is too dense to
//! draw point-for-point, happens inside the query and never touches disk.

mod db;
mod query;

use anyhow::Result;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use clap::Parser;
use serde::Deserialize;
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tower_http::services::ServeDir;

use crate::db::{Catalog, Db};

/// The page chooses its own memory budget and sends it with each request; these
/// are the bounds it has to choose within. The ceiling is deliberately not
/// configurable — it is the point past which a response stops being something a
/// browser can hold, not a matter of taste.
const MAX_POINTS_CEILING: i64 = 4_000_000;
const MAX_POINTS_FLOOR: i64 = 1_000;
const DEFAULT_MAX_POINTS: i64 = 1_000_000;

#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct Limits {
    /// Most values one `/api/data` response may ever materialise.
    pub max_points_ceiling: i64,
    /// What a request gets if it names no budget of its own.
    pub default_max_points: i64,
    /// Channels one request may name.
    pub max_channels: usize,
}

#[derive(Clone)]
struct AppState {
    db: Arc<Db>,
    limits: Limits,
}

#[derive(Parser, Debug)]
#[command(name = "elf", version, about = "Multi-channel viewer over a raw parquet time-series store")]
struct Args {
    /// orc data directory (the one holding manifest.json and series/)
    #[arg(long)]
    data: PathBuf,

    /// Static assets to serve
    #[arg(long, default_value = concat!(env!("CARGO_MANIFEST_DIR"), "/web"))]
    web: PathBuf,

    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    #[arg(long, default_value_t = 8787)]
    port: u16,

    /// Channels a single request may name.
    #[arg(long, default_value_t = 10)]
    max_channels: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    eprintln!("elf: opening {}", args.data.display());
    let db = Arc::new(Db::open(&args.data)?);
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
        default_max_points: DEFAULT_MAX_POINTS,
        max_channels: args.max_channels.max(1),
    };
    eprintln!(
        "  limits: up to {} points/response, {} channels/request",
        limits.max_points_ceiling, limits.max_channels
    );

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/catalog", get(catalog))
        .route("/api/coverage", get(coverage))
        .route("/api/data", get(data))
        .fallback_service(ServeDir::new(&args.web).append_index_html_on_directories(true))
        .with_state(AppState { db, limits });

    let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    eprintln!("elf: http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

// ------------------------------------------------------------------ routes --

/// A heartbeat the page polls to tell "server gone" from "nothing to ask for".
/// Deliberately touches no state: it answers while a heavy query is in flight,
/// so the indicator reports reachability rather than load.
async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

#[derive(serde::Serialize)]
struct CatalogResponse {
    #[serde(flatten)]
    catalog: Catalog,
    limits: Limits,
}

async fn catalog(State(st): State<AppState>) -> impl IntoResponse {
    Json(CatalogResponse {
        catalog: st.db.catalog.clone(),
        limits: st.limits,
    })
}

#[derive(Deserialize)]
struct CoverageParams {
    /// Resolution at which occupancy is probed. Smaller finds smaller gaps.
    #[serde(default = "default_bucket_ms")]
    bucket_ms: i64,
}

fn default_bucket_ms() -> i64 {
    60_000
}

async fn coverage(
    State(st): State<AppState>,
    Query(p): Query<CoverageParams>,
) -> Result<Json<query::Coverage>, ApiError> {
    let out = blocking(move || query::coverage(&st.db, p.bucket_ms.max(1) * 1_000)).await?;
    Ok(Json(out))
}

#[derive(Deserialize)]
struct DataParams {
    /// Window start, epoch micros (inclusive).
    from: i64,
    /// Window end, epoch micros (exclusive).
    to: i64,
    /// Comma-separated `<series>:<field>` ids.
    channels: String,
    #[serde(default = "default_buckets")]
    buckets: i64,
    #[serde(default = "default_max_raw")]
    max_raw: i64,
    /// Values this response may materialise. The page sets it; the server
    /// clamps it to something it is willing to build.
    #[serde(default = "default_max_points")]
    max_points: i64,
}

fn default_buckets() -> i64 {
    1200
}

fn default_max_raw() -> i64 {
    12_000
}

fn default_max_points() -> i64 {
    DEFAULT_MAX_POINTS
}

async fn data(
    State(st): State<AppState>,
    Query(p): Query<DataParams>,
) -> Result<Json<query::DataResponse>, ApiError> {
    let channels: Vec<String> = p
        .channels
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if channels.is_empty() {
        return Err(ApiError(anyhow::anyhow!("no channels requested")));
    }
    if channels.len() > st.limits.max_channels {
        return Err(ApiError(anyhow::anyhow!(
            "at most {} channels per request, got {}",
            st.limits.max_channels,
            channels.len()
        )));
    }

    let out = blocking(move || {
        query::data(
            &st.db,
            &query::DataRequest {
                from: p.from,
                to: p.to,
                buckets: p.buckets,
                max_raw: p.max_raw.max(0),
                max_points: p.max_points.clamp(MAX_POINTS_FLOOR, MAX_POINTS_CEILING),
                channels: &channels,
            },
        )
    })
    .await?;
    Ok(Json(out))
}

// ------------------------------------------------------------------- glue ---

/// DuckDB calls block, so they run off the async runtime's worker threads.
async fn blocking<T, F>(f: F) -> Result<T, ApiError>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError(anyhow::anyhow!("task panicked: {e}")))?
        .map_err(ApiError)
}

struct ApiError(anyhow::Error);

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": self.0.to_string() })),
        )
            .into_response()
    }
}
