use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

const DEFAULT_HIT_FILTER_IDS: [u32; 1] = [8];

#[derive(Clone)]
struct AppState {
    planner_root: PathBuf,
}

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

impl ApiError {
    fn new(msg: impl Into<String>) -> Self {
        Self { error: msg.into() }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, Json(self)).into_response()
    }
}

#[derive(Debug, Serialize)]
struct MapListResponse {
    maps: Vec<MapListItem>,
}

#[derive(Debug, Serialize)]
struct MapListItem {
    map_id: String,
    display_name: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct CollisionManifest {
    #[serde(default)]
    map_id: String,
    #[serde(default)]
    instances: Vec<CollisionInstance>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct CollisionInstance {
    #[serde(rename = "OutObjFile")]
    out_obj_file: String,
    #[serde(rename = "MsbHitFilterId")]
    msb_hit_filter_id: u32,
    #[serde(rename = "MsbHitFilterType")]
    msb_hit_filter_type: String,
    #[serde(rename = "OutObjSizeBytes", default)]
    out_obj_size_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct NavmeshManifest {
    #[serde(default)]
    navmeshes: Vec<NavmeshEntry>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct NavmeshEntry {
    path: String,
    #[serde(default)]
    name: String,
    #[serde(default, alias = "obj_size_bytes", alias = "ObjSizeBytes")]
    obj_size_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct FilterProfile {
    map_id: String,
    collision_enabled_paths: Vec<String>,
    navmesh_enabled_paths: Vec<String>,
    #[serde(default)]
    culled_triangles: Vec<CulledTrianglesEntry>,
    updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct CulledTrianglesEntry {
    kind: String,
    path: String,
    #[serde(default)]
    ranges: Vec<[u32; 2]>,
}

#[derive(Debug, Deserialize)]
struct SaveFilterProfileRequest {
    collision_enabled_paths: Vec<String>,
    navmesh_enabled_paths: Vec<String>,
    #[serde(default)]
    culled_triangles: Vec<CulledTrianglesEntry>,
}

#[derive(Debug, Serialize)]
struct MapContentResponse {
    map_id: String,
    default_hit_filter_ids: Vec<u32>,
    collision_manifest: CollisionManifest,
    navmesh_manifest: NavmeshManifest,
    saved_profile_exists: bool,
    saved_profile: Option<FilterProfile>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cwd = std::env::current_dir().context("failed to get current dir")?;
    let planner_root = cwd.join("map-work").join("capture-planner");
    let web_root = cwd.join("ds3-map-planner").join("web");

    let state = AppState { planner_root };

    let api = Router::new()
        .route("/maps", get(get_maps))
        .route("/maps/{map_id}/content", get(get_map_content))
        .route("/maps/{map_id}/filter-profile", put(save_filter_profile));

    let map_work_root = cwd.join("map-work");

    let app = Router::new()
        .nest("/api", api)
        .nest_service("/map-work", ServeDir::new(map_work_root))
        .with_state(state)
        .layer(CorsLayer::permissive())
        .fallback_service(ServeDir::new(web_root).append_index_html_on_directories(true));

    let addr: SocketAddr = "127.0.0.1:7878".parse().unwrap();
    let url = format!("http://{addr}/");
    let _ = webbrowser::open(&url);
    println!("Serving {url}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn get_maps(State(state): State<AppState>) -> Result<Json<MapListResponse>, ApiError> {
    let mut maps = Vec::new();
    let rd = std::fs::read_dir(&state.planner_root)
        .map_err(|e| ApiError::new(format!("failed to read planner root: {e}")))?;
    for entry in rd {
        let entry = entry.map_err(|e| ApiError::new(format!("failed to read dir entry: {e}")))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|x| x.to_str()) else {
            continue;
        };
        if !is_valid_map_id(name) {
            continue;
        }
        let c = path.join("collision_world.json");
        let n = path.join("navmesh_manifest.json");
        if c.exists() && n.exists() {
            maps.push(MapListItem {
                map_id: name.to_string(),
                display_name: map_display_name(name),
            });
        }
    }
    maps.sort_by(|a, b| a.map_id.cmp(&b.map_id));
    Ok(Json(MapListResponse { maps }))
}

fn map_display_name(map_id: &str) -> String {
    match map_id {
        "m21_00_00_00" => "Base",
        "m30_00_00_00" => "High Wall of Lothric / Garden",
        "m30_01_00_00" => "Lothric Castle",
        "m30_02_00_00" => "Eclipsed Royal Castle 2",
        "m31_00_00_00" => "Undead Settlement",
        "m31_02_00_00" => "Spire Town (For Bake Test)",
        "m32_00_00_00" => "Archdragon Peak",
        "m32_90_00_00" => "Bridge For Bake Test",
        "m33_00_00_00" => "Road of Sacrifices / Farron Keep",
        "m34_00_00_00" => "Eclipsed Royal Castle 2",
        "m34_01_00_00" => "Grand Archives",
        "m35_00_00_00" => "Cathedral of the Deep",
        "m36_00_00_00" => "The Grave Of God",
        "m36_90_00_00" => "The Grave Of God 2",
        "m37_00_00_00" => "Irithyll / Anor Londo",
        "m38_00_00_00" => "Catacombs Carthus / Smouldering Lake",
        "m39_00_00_00" => "Dungeon / Profaned Capital",
        "m40_00_00_00" => "Cemetary / Firelink / Untended Graves",
        "m41_00_00_00" => "Kiln of Flame / Flameless Shrine",
        "m45_00_00_00" => "Painted World of Ariandel",
        "m46_00_00_00" => "Arena - Grand Roof",
        "m47_00_00_00" => "Arena - Kiln of Flame",
        "m50_00_00_00" => "Dreg Heap",
        "m51_00_00_00" => "Ringed City",
        "m51_01_00_00" => "Filianore's Rest",
        "m53_00_00_00" => "Arena - Dragon Ruins",
        "m54_00_00_00" => "Arena - Round Plaza",
        _ => map_id,
    }
    .to_string()
}

async fn get_map_content(
    State(state): State<AppState>,
    AxumPath(map_id): AxumPath<String>,
) -> Result<Json<MapContentResponse>, ApiError> {
    validate_map_id(&map_id)?;
    let map_dir = resolve_map_dir(&state, &map_id)?;
    let collision_manifest: CollisionManifest =
        read_json(&map_dir.join("collision_world.json"), "collision manifest")?;
    let navmesh_manifest: NavmeshManifest =
        read_json(&map_dir.join("navmesh_manifest.json"), "navmesh manifest")?;
    let profile_path = map_dir.join("filter_profile.json");
    let saved_profile = if profile_path.exists() {
        Some(read_json::<FilterProfile>(&profile_path, "filter profile")?)
    } else {
        None
    };
    let saved_profile_exists = saved_profile.is_some();

    Ok(Json(MapContentResponse {
        map_id,
        default_hit_filter_ids: DEFAULT_HIT_FILTER_IDS.to_vec(),
        collision_manifest,
        navmesh_manifest,
        saved_profile_exists,
        saved_profile,
    }))
}

async fn save_filter_profile(
    State(state): State<AppState>,
    AxumPath(map_id): AxumPath<String>,
    Json(body): Json<SaveFilterProfileRequest>,
) -> Result<StatusCode, ApiError> {
    validate_map_id(&map_id)?;
    let map_dir = resolve_map_dir(&state, &map_id)?;
    let profile_path = map_dir.join("filter_profile.json");
    let payload = FilterProfile {
        map_id,
        collision_enabled_paths: body.collision_enabled_paths,
        navmesh_enabled_paths: body.navmesh_enabled_paths,
        culled_triangles: body.culled_triangles,
        updated_at: Utc::now().to_rfc3339(),
    };

    let text = serde_json::to_string_pretty(&payload)
        .map_err(|e| ApiError::new(format!("failed to serialize profile: {e}")))?;
    std::fs::write(&profile_path, text)
        .map_err(|e| ApiError::new(format!("failed to write profile: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, what: &str) -> Result<T, ApiError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| ApiError::new(format!("failed to read {what}: {e}")))?;
    let text = text.trim_start_matches('\u{feff}');
    serde_json::from_str(text).map_err(|e| ApiError::new(format!("failed to parse {what}: {e}")))
}

fn validate_map_id(map_id: &str) -> Result<(), ApiError> {
    if is_valid_map_id(map_id) {
        return Ok(());
    }
    Err(ApiError::new("invalid map_id"))
}

fn is_valid_map_id(map_id: &str) -> bool {
    if map_id.len() != 12 || !map_id.starts_with('m') {
        return false;
    }
    let b = map_id.as_bytes();
    b[1].is_ascii_digit()
        && b[2].is_ascii_digit()
        && b[3] == b'_'
        && b[4].is_ascii_digit()
        && b[5].is_ascii_digit()
        && b[6] == b'_'
        && b[7].is_ascii_digit()
        && b[8].is_ascii_digit()
        && b[9] == b'_'
        && b[10].is_ascii_digit()
        && b[11].is_ascii_digit()
}

fn resolve_map_dir(state: &AppState, map_id: &str) -> Result<PathBuf, ApiError> {
    let dir = state.planner_root.join(map_id);
    if !dir.exists() || !dir.is_dir() {
        return Err(ApiError::new("map directory not found"));
    }
    Ok(dir)
}
