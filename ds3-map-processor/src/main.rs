mod common;
mod coord_space;
mod fs_utils;
mod geom;
mod stage0_shot_points;
mod stage1_pointcloud;
mod stage2_shot_points;
mod stage2_tile_pipeline;
mod stage3_merge;
mod task_budget;
mod tile_pyramid;
mod walkable_exp;

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
    group_tomls_by_first_subdir,
};
use crate::stage0_shot_points::run_shot_points_stage;
use crate::stage1_pointcloud::{
    make_tile_pixel_ref, preprocess_capture_tile_spans, tile_key, write_tile_pixel_index,
};
use crate::stage2_shot_points::write_shot_points_from_capture_tomls;
use crate::stage2_tile_pipeline::render_tiles_to_pyramid;
use crate::stage3_merge::merge_stage2_outputs;
use crate::task_budget::run_with_budget;
use crate::walkable_exp::run_walkable_experiment;

#[derive(Clone, Copy, PartialEq, Eq)]
enum RunMode {
    ShotPoints,
    Stage12,
    Stage3,
    Stage123,
    WalkableExp,
}

fn main() -> Result<()> {
    let total_start = Instant::now();
    let repo_root = find_repo_root()?;
    let capture_dir = repo_root.join("capture");
    let work_dir = repo_root.join("map-work");
    ensure_workdir_layout(&work_dir)?;
    let (run_mode, selected_filter) = parse_args(std::env::args().collect())?;

    let stage2_root = work_dir.join("stage2");
    let mut stage2_outputs = Vec::new();
    let mut stage1_peak_global = 0usize;
    let mut stage2_peak_point_global = 0usize;
    let mut stage2_peak_cache_global = 0usize;

    if run_mode == RunMode::ShotPoints {
        let n = run_shot_points_stage(&capture_dir, selected_filter.as_deref())?;
        println!("shot-points done. subfolders written: {}", n);
        return Ok(());
    }
    if run_mode == RunMode::WalkableExp {
        run_walkable_experiment(&capture_dir, &work_dir, selected_filter.as_deref())?;
        return Ok(());
    }

    if run_mode == RunMode::Stage123 || run_mode == RunMode::Stage12 {
        let selected_all = find_all_toml_in_capture(&capture_dir)?;
        let groups = group_tomls_by_first_subdir(&capture_dir, &selected_all)?;
        let mut picked: Vec<(String, Vec<std::path::PathBuf>)> = Vec::new();
        for (name, tomls) in groups {
            if let Some(ref filters) = selected_filter {
                if !filters.iter().any(|f| f == &name) {
                    continue;
                }
            }
            picked.push((name, tomls));
        }
        if picked.is_empty() {
            anyhow::bail!("No capture subfolders selected.");
        }

        fs::create_dir_all(&stage2_root)
            .with_context(|| format!("mkdir {}", stage2_root.display()))?;
        let clear_all_stage2 = selected_filter.is_none();
        if clear_all_stage2 {
            clear_directory(&stage2_root)?;
        }

        for (group_name, selected) in picked {
            println!("=== Subfolder: {} ({} capture(s)) ===", group_name, selected.len());
            let stage1_start = Instant::now();
            let group_root = stage2_root.join(&group_name);
            fs::create_dir_all(&group_root)
                .with_context(|| format!("mkdir {}", group_root.display()))?;
            if !clear_all_stage2 {
                clear_directory(&group_root)?;
            }
            let tile_index_path = group_root.join("tile_pixel_index.json");
            let finest_z = SCALE_WORLD_UNITS_PER_PIXEL.len() - 1;
            let tile_world_size = TILE_SIZE_PX as f32 * SCALE_WORLD_UNITS_PER_PIXEL[finest_z];

            let all_refs =
                Arc::new(Mutex::new(Vec::<(String, String, crate::common::PixelAabb)>::new()));
            let stage1_peak_inflight = run_with_budget(
                selected.clone(),
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
            stage1_peak_global = stage1_peak_global.max(stage1_peak_inflight);

            let mut index = TilePixelIndex {
                version: 1,
                tile_world_size,
                finest_z,
                tiles: std::collections::BTreeMap::new(),
            };
            for (tkey, capture_toml, aabb) in all_refs.lock().expect("all_refs poisoned").drain(..)
            {
                index
                    .tiles
                    .entry(tkey)
                    .or_default()
                    .push(make_tile_pixel_ref(Path::new(&capture_toml), aabb));
            }
            write_tile_pixel_index(&index, &tile_index_path)?;
            println!("Stage 1/2 done in {:.3}s", stage1_start.elapsed().as_secs_f64());

            let stage2_start = Instant::now();
            let tiles_root = group_root.join("tiles");
            fs::create_dir_all(&tiles_root)
                .with_context(|| format!("mkdir {}", tiles_root.display()))?;
            clear_directory(&tiles_root)?;
            let alerts_path = group_root.join("alerts.csv");
            let index_path = tiles_root.join("index.json");
            let group_capture_dir = capture_dir.join(&group_name);
            write_shot_points_from_capture_tomls(&group_capture_dir, &group_root)?;
            let stage2_stats = render_tiles_to_pyramid(
                &group_capture_dir,
                &tile_index_path,
                &tiles_root,
                &alerts_path,
                &index_path,
            )?;
            println!("Stage 2/2 done in {:.3}s", stage2_start.elapsed().as_secs_f64());
            stage2_peak_point_global =
                stage2_peak_point_global.max(stage2_stats.point_inflight_peak_bytes);
            stage2_peak_cache_global =
                stage2_peak_cache_global.max(stage2_stats.capture_cache_peak_bytes);
            stage2_outputs.push(group_root.join("tiles"));
        }
    } else {
        if !stage2_root.is_dir() {
            anyhow::bail!("stage2 output directory not found: {}", stage2_root.display());
        }
        for entry in fs::read_dir(&stage2_root)
            .with_context(|| format!("read_dir {}", stage2_root.display()))?
        {
            let entry = entry?;
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(ref filters) = selected_filter {
                if !filters.iter().any(|f| f == &name) {
                    continue;
                }
            }
            let tiles = p.join("tiles");
            if tiles.join("finest_manifest.json").is_file() && tiles.join("index.json").is_file() {
                stage2_outputs.push(tiles);
            }
        }
        stage2_outputs.sort();
        if stage2_outputs.is_empty() {
            anyhow::bail!("No stage2 outputs selected for stage3 merge.");
        }
    }

    if run_mode == RunMode::Stage123 || run_mode == RunMode::Stage3 {
        let stage3_out = work_dir.join("tiles");
        fs::create_dir_all(&stage3_out)
            .with_context(|| format!("mkdir {}", stage3_out.display()))?;
        clear_directory(&stage3_out)?;
        merge_stage2_outputs(&stage2_outputs, &stage3_out)?;
    }

    println!(
        "Done in {:.3}s. output root: {}",
        total_start.elapsed().as_secs_f64(),
        work_dir.display()
    );
    println!(
        "Peak point in-flight: {:.2} GB / {} GB",
        stage1_peak_global.max(stage2_peak_point_global) as f64 / (1024.0 * 1024.0 * 1024.0),
        crate::common::MAX_POINT_IN_FLIGHT_GB
    );
    println!(
        "Peak capture cache: {:.2} GB / {} GB",
        stage2_peak_cache_global as f64 / (1024.0 * 1024.0 * 1024.0),
        crate::common::CAPTURE_CACHE_GB
    );
    Ok(())
}

fn parse_maps_filter(args: &[String]) -> Option<Vec<String>> {
    let mut i = 0usize;
    while i < args.len() {
        if args[i] == "--maps" && i + 1 < args.len() {
            let parts = args[i + 1]
                .split(';')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            return if parts.is_empty() { None } else { Some(parts) };
        }
        i += 1;
    }
    None
}

fn parse_args(args: Vec<String>) -> Result<(RunMode, Option<Vec<String>>)> {
    let mut mode = RunMode::Stage123;
    let mut i = 0usize;
    while i < args.len() {
        if args[i] == "--run" && i + 1 < args.len() {
            mode = match args[i + 1].as_str() {
                "shotpoints" => RunMode::ShotPoints,
                "stage12" => RunMode::Stage12,
                "stage3" => RunMode::Stage3,
                "stage123" => RunMode::Stage123,
                "walkable-exp" => RunMode::WalkableExp,
                other => anyhow::bail!(
                    "Invalid --run value: {} (expected shotpoints|stage12|stage3|stage123|walkable-exp)",
                    other
                ),
            };
        }
        i += 1;
    }
    Ok((mode, parse_maps_filter(&args)))
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
