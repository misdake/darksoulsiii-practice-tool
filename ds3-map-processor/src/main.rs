mod common;
mod fs_utils;
mod stage1_pointcloud;
mod stage2_bin_split;
mod stage3_tile_pyramid;

use anyhow::{Context, Result};
use std::fs;

use crate::fs_utils::{
    clear_directory, ensure_workdir_layout, find_all_toml_in_capture, find_repo_root,
};
use crate::stage1_pointcloud::{
    export_point_cloud_binary_v2, load_capture_from_toml, INPUT_CAPTURE_LIMIT, POINT_STRIDE,
};
use crate::stage2_bin_split::split_pointclouds_into_bins;
use crate::stage3_tile_pyramid::render_bins_to_tile_pyramid;

fn main() -> Result<()> {
    let repo_root = find_repo_root()?;
    let capture_dir = repo_root.join("capture");
    let work_dir = repo_root.join("map-work");
    ensure_workdir_layout(&work_dir)?;

    let toml_paths = find_all_toml_in_capture(&capture_dir)?;
    let selected: Vec<_> = toml_paths.into_iter().take(INPUT_CAPTURE_LIMIT).collect();
    println!(
        "Stage 1/3 capture->pointcloud: {} capture(s), stride={}.",
        selected.len(),
        POINT_STRIDE
    );

    for toml_path in &selected {
        let capture = load_capture_from_toml(toml_path)?;
        let out_path = toml_path.with_extension("ds3pcd");
        export_point_cloud_binary_v2(&capture, &out_path, POINT_STRIDE)?;
        println!("  wrote point cloud: {}", out_path.display());
    }

    println!("Stage 2/3 pointcloud->bin split.");
    let bins_root = work_dir.join("bins");
    fs::create_dir_all(&bins_root).with_context(|| format!("mkdir {}", bins_root.display()))?;
    clear_directory(&bins_root)?;
    split_pointclouds_into_bins(&selected, &bins_root)?;

    println!("Stage 3/3 render bin->tile pyramid.");
    let tiles_root = work_dir.join("tiles");
    fs::create_dir_all(&tiles_root).with_context(|| format!("mkdir {}", tiles_root.display()))?;
    clear_directory(&tiles_root)?;
    let alerts_path = work_dir.join("alerts.csv");
    let index_path = tiles_root.join("index.json");
    render_bins_to_tile_pyramid(&bins_root, &tiles_root, &alerts_path, &index_path)?;

    println!("Done. output root: {}", work_dir.display());
    Ok(())
}
