mod common;
mod fs_utils;
mod stage1_pointcloud;
mod stage2_tile_pipeline;
mod task_budget;

use anyhow::{Context, Result};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::common::{
    CaptureToml, TilePixelIndex, MAX_POINT_BYTES_IN_FLIGHT, SCALE_WORLD_UNITS_PER_PIXEL,
    TILE_SIZE_PX,
};
use crate::fs_utils::{
    clear_directory, ensure_workdir_layout, find_all_toml_in_capture, find_repo_root,
};
use crate::stage1_pointcloud::{
    make_tile_pixel_ref, preprocess_capture_tile_spans, tile_key, write_tile_pixel_index,
};
use crate::stage2_tile_pipeline::render_tiles_to_pyramid;
use crate::task_budget::run_with_budget;

fn main() -> Result<()> {
    let total_start = Instant::now();
    let repo_root = find_repo_root()?;
    let capture_dir = repo_root.join("capture");
    let work_dir = repo_root.join("map-work");
    ensure_workdir_layout(&work_dir)?;

    let selected = find_all_toml_in_capture(&capture_dir)?;
    println!("Stage 1/2 preprocess tile index: {} capture(s).", selected.len());
    let stage1_start = Instant::now();
    let tile_index_path = work_dir.join("tile_pixel_index.json");
    let finest_z = SCALE_WORLD_UNITS_PER_PIXEL.len() - 1;
    let tile_world_size = TILE_SIZE_PX as f32 * SCALE_WORLD_UNITS_PER_PIXEL[finest_z];

    let all_refs = Arc::new(Mutex::new(Vec::<(String, String, crate::common::PixelAabb)>::new()));

    let stage1_peak_inflight = run_with_budget(
        selected,
        |toml_path| estimate_capture_bytes(toml_path).unwrap_or(1),
        MAX_POINT_BYTES_IN_FLIGHT,
        std::thread::available_parallelism().map_or(1usize, |n| n.get().max(1)),
        {
            let all_refs = Arc::clone(&all_refs);
            move |toml_path, reserved_bytes| {
                let spans = preprocess_capture_tile_spans(&toml_path)?;
                let capture_key = toml_path.to_string_lossy().to_string();
                let mut local = Vec::with_capacity(spans.len());
                for ((tx, ty), aabb) in spans {
                    local.push((tile_key(tx, ty), capture_key.clone(), aabb));
                }
                all_refs.lock().expect("all_refs poisoned").extend(local);
                println!(
                    "  indexed {} in_flight={}MB",
                    toml_path.display(),
                    reserved_bytes / (1024 * 1024)
                );
                Ok(())
            }
        },
    )?;

    let mut index = TilePixelIndex {
        version: 1,
        tile_world_size,
        finest_z,
        tiles: std::collections::BTreeMap::new(),
    };
    for (tkey, capture_toml, aabb) in all_refs.lock().expect("all_refs poisoned").drain(..) {
        index
            .tiles
            .entry(tkey)
            .or_default()
            .push(make_tile_pixel_ref(Path::new(&capture_toml), aabb));
    }
    write_tile_pixel_index(&index, &tile_index_path)?;
    println!("Stage 1/2 done in {:.3}s", stage1_start.elapsed().as_secs_f64());

    println!("Stage 2/2 tile render->tile pyramid.");
    let stage2_start = Instant::now();
    let tiles_root = work_dir.join("tiles");
    fs::create_dir_all(&tiles_root).with_context(|| format!("mkdir {}", tiles_root.display()))?;
    clear_directory(&tiles_root)?;
    let alerts_path = work_dir.join("alerts.csv");
    let index_path = tiles_root.join("index.json");
    let stage2_stats = render_tiles_to_pyramid(
        &capture_dir,
        &tile_index_path,
        &tiles_root,
        &alerts_path,
        &index_path,
    )?;
    println!("Stage 2/2 done in {:.3}s", stage2_start.elapsed().as_secs_f64());

    println!(
        "Done in {:.3}s. output root: {}",
        total_start.elapsed().as_secs_f64(),
        work_dir.display()
    );
    println!(
        "Peak point in-flight: {:.2} GB / {} GB",
        stage1_peak_inflight.max(stage2_stats.point_inflight_peak_bytes) as f64
            / (1024.0 * 1024.0 * 1024.0),
        crate::common::MAX_POINT_IN_FLIGHT_GB
    );
    println!(
        "Peak capture cache: {:.2} GB / {} GB",
        stage2_stats.capture_cache_peak_bytes as f64 / (1024.0 * 1024.0 * 1024.0),
        crate::common::CAPTURE_CACHE_GB
    );
    Ok(())
}

fn estimate_capture_bytes(toml_path: &Path) -> Result<usize> {
    let content =
        fs::read_to_string(toml_path).with_context(|| format!("read {}", toml_path.display()))?;
    let meta: CaptureToml = toml::from_str(&content).context("parse capture toml")?;
    let base_dir = toml_path.parent().context("toml has no parent directory")?;
    let rgb_size =
        fs::metadata(base_dir.join(meta.rgb_file)).map(|m| m.len() as usize).unwrap_or(0);
    let exr_size =
        fs::metadata(base_dir.join(meta.depth_file)).map(|m| m.len() as usize).unwrap_or(0);
    Ok((rgb_size + exr_size).max(1))
}
