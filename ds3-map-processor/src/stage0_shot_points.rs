use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::coord_space::{convert_z, parse_coord_space, CoordSpace};
use crate::geom::{dist2_point_seg, point_in_polygon};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TrajectoryFile {
    #[serde(default)]
    pub coord_space: String,
    pub version: u32,
    #[serde(default)]
    pub close_distance: f32,
    #[serde(default)]
    pub loops: Vec<Vec<[f32; 3]>>,
    #[serde(default)]
    pub polylines: Vec<Vec<[f32; 3]>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ShotConfig {
    #[serde(alias = "screen_width")]
    pub render_width: u32,
    #[serde(alias = "screen_height")]
    pub render_height: u32,
    #[serde(default = "default_fov_y_rad")]
    pub fov_y_rad: f32,
    pub base_ratio_px_per_wu: f32,
    pub density_multiplier: f32,
    pub overlap_ratio: f32,
    pub polyline_buffer_world: f32,
    pub y_neighbor_k: usize,
    pub y_lift: f32,
    pub wait_load_ms: u64,
    pub wait_shot_ms: u64,
}

fn default_fov_y_rad() -> f32 {
    0.9
}

impl Default for ShotConfig {
    fn default() -> Self {
        Self {
            render_width: 2560,
            render_height: 1440,
            fov_y_rad: 0.9,
            base_ratio_px_per_wu: 32.0,
            density_multiplier: 2.0,
            overlap_ratio: 0.5,
            polyline_buffer_world: 2.0,
            y_neighbor_k: 5,
            y_lift: 2.0,
            wait_load_ms: 500,
            wait_shot_ms: 1000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShotPoint {
    pub id: usize,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub y_ref: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShotPointsFile {
    pub coord_space: String,
    pub version: u32,
    pub density_px_per_wu: f32,
    pub render_width: u32,
    pub render_height: u32,
    pub fov_y_rad: f32,
    pub camera_height_from_y_ref: f32,
    pub overlap_ratio: f32,
    pub step_x: f32,
    pub step_z: f32,
    pub wait_load_ms: u64,
    pub wait_shot_ms: u64,
    pub points: Vec<ShotPoint>,
    pub stats: ShotStats,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShotStats {
    pub loops: usize,
    pub polylines: usize,
    pub candidate_points: usize,
    pub accepted_points: usize,
}

pub fn run_shot_points_stage(
    capture_dir: &Path,
    selected_filter: Option<&[String]>,
) -> Result<usize> {
    let mut subdirs = find_capture_subdirs(capture_dir)?;
    subdirs.sort();
    let mut written = 0usize;
    for subdir in subdirs {
        let rel = subdir
            .strip_prefix(capture_dir)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if let Some(filters) = selected_filter {
            let head = rel.split('/').next().unwrap_or("");
            if !filters.iter().any(|f| f == head) {
                continue;
            }
        }
        let traj_path = subdir.join("trajectory.toml");
        let cfg_path = subdir.join("shot_config.toml");
        if !traj_path.is_file() || !cfg_path.is_file() {
            continue;
        }
        let traj: TrajectoryFile = toml::from_str(
            &fs::read_to_string(&traj_path)
                .with_context(|| format!("read {}", traj_path.display()))?,
        )
        .with_context(|| format!("parse {}", traj_path.display()))?;
        let cfg: ShotConfig = toml::from_str(
            &fs::read_to_string(&cfg_path)
                .with_context(|| format!("read {}", cfg_path.display()))?,
        )
        .with_context(|| format!("parse {}", cfg_path.display()))?;
        let out = build_shot_points(&traj, &cfg)?;
        let out_path = subdir.join("shot_points.json");
        fs::write(&out_path, serde_json::to_vec_pretty(&out).context("serialize shot_points")?)
            .with_context(|| format!("write {}", out_path.display()))?;
        println!("shot_points: {} points -> {}", out.points.len(), out_path.display());
        written += 1;
    }
    if written == 0 {
        anyhow::bail!("No trajectory.toml + shot_config.toml pairs found under capture/.");
    }
    Ok(written)
}

fn find_capture_subdirs(capture_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
        for e in fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))? {
            let e = e?;
            let p = e.path();
            if p.is_dir() {
                out.push(p.clone());
                walk(&p, out)?;
            }
        }
        Ok(())
    }
    if capture_dir.is_dir() {
        walk(capture_dir, &mut out)?;
    }
    Ok(out)
}

fn build_shot_points(traj: &TrajectoryFile, cfg: &ShotConfig) -> Result<ShotPointsFile> {
    let traj_space = parse_coord_space(&traj.coord_space);
    let density = (cfg.base_ratio_px_per_wu.max(1.0e-6)) * (cfg.density_multiplier.max(1.0e-6));
    let overlap = cfg.overlap_ratio.clamp(0.0, 0.95);
    let coverage_h = cfg.render_height as f32 / density;
    // Use only the center h*h square as effective coverage. Side regions are treated as redundancy.
    let coverage_square = coverage_h;
    let step_x = (coverage_square * (1.0 - overlap)).max(0.01);
    let step_z = (coverage_square * (1.0 - overlap)).max(0.01);
    let half_fov = (cfg.fov_y_rad * 0.5).clamp(1.0e-4, std::f32::consts::PI * 0.5 - 1.0e-4);
    let camera_height_from_y_ref = (coverage_square * 0.5) / half_fov.tan().max(1.0e-6);

    let mut all_pts: Vec<[f32; 3]> = Vec::new();
    for lp in &traj.loops {
        for p in lp {
            let gz = convert_z(p[2], traj_space, CoordSpace::Game);
            all_pts.push([p[0], p[1], -gz]);
        }
    }
    for ln in &traj.polylines {
        for p in ln {
            let gz = convert_z(p[2], traj_space, CoordSpace::Game);
            all_pts.push([p[0], p[1], -gz]);
        }
    }
    if all_pts.is_empty() {
        anyhow::bail!("trajectory has no points");
    }

    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_z = f32::INFINITY;
    let mut max_z = f32::NEG_INFINITY;
    for p in &all_pts {
        min_x = min_x.min(p[0]);
        max_x = max_x.max(p[0]);
        min_z = min_z.min(p[2]);
        max_z = max_z.max(p[2]);
    }

    min_x -= step_x;
    max_x += step_x;
    min_z -= step_z;
    max_z += step_z;

    let mut points = Vec::new();
    let mut candidate = 0usize;
    let mut id = 0usize;
    let mut z = min_z;
    while z <= max_z {
        let mut x = min_x;
        while x <= max_x {
            candidate += 1;
            if point_in_region_conservative(
                x,
                z,
                step_x,
                step_z,
                traj,
                traj_space,
                cfg.polyline_buffer_world.max(0.0),
            ) {
                let y_ref = estimate_y(x, z, &all_pts, cfg.y_neighbor_k.max(1));
                points.push(ShotPoint {
                    id,
                    x,
                    y: y_ref + camera_height_from_y_ref + cfg.y_lift,
                    z: -z,
                    y_ref,
                });
                id += 1;
            }
            x += step_x;
        }
        z += step_z;
    }

    Ok(ShotPointsFile {
        coord_space: CoordSpace::Game.as_str().to_string(),
        version: 1,
        density_px_per_wu: density,
        render_width: cfg.render_width,
        render_height: cfg.render_height,
        fov_y_rad: cfg.fov_y_rad,
        camera_height_from_y_ref,
        overlap_ratio: overlap,
        step_x,
        step_z,
        wait_load_ms: cfg.wait_load_ms,
        wait_shot_ms: cfg.wait_shot_ms,
        stats: ShotStats {
            loops: traj.loops.len(),
            polylines: traj.polylines.len(),
            candidate_points: candidate,
            accepted_points: points.len(),
        },
        points,
    })
}

fn point_in_region_conservative(
    x: f32,
    z: f32,
    step_x: f32,
    step_z: f32,
    traj: &TrajectoryFile,
    traj_space: CoordSpace,
    polyline_buffer: f32,
) -> bool {
    let hx = step_x * 0.5;
    let hz = step_z * 0.5;
    let half_diag = (hx * hx + hz * hz).sqrt();
    let sample_pts = [
        [x, z],
        [x - hx, z - hz],
        [x - hx, z + hz],
        [x + hx, z - hz],
        [x + hx, z + hz],
    ];

    for lp in &traj.loops {
        if lp.len() < 3 {
            continue;
        }
        let poly: Vec<[f32; 2]> = lp
            .iter()
            .map(|p| [p[0], -convert_z(p[2], traj_space, CoordSpace::Game)])
            .collect();
        for s in sample_pts {
            if point_in_polygon(s[0], s[1], &poly) {
                return true;
            }
        }
        for i in 0..poly.len() {
            let a = poly[i];
            let b = poly[(i + 1) % poly.len()];
            if dist2_point_seg(x, z, a[0], a[1], b[0], b[1]) <= half_diag * half_diag {
                return true;
            }
        }
    }

    let line_r = polyline_buffer + half_diag;
    let b2 = line_r * line_r;
    for ln in &traj.polylines {
        if ln.len() < 2 {
            continue;
        }
        for i in 0..(ln.len() - 1) {
            let a = [ln[i][0], -convert_z(ln[i][2], traj_space, CoordSpace::Game)];
            let b = [
                ln[i + 1][0],
                -convert_z(ln[i + 1][2], traj_space, CoordSpace::Game),
            ];
            if dist2_point_seg(x, z, a[0], a[1], b[0], b[1]) <= b2 {
                return true;
            }
        }
    }
    false
}

fn estimate_y(x: f32, z: f32, pts: &[[f32; 3]], k: usize) -> f32 {
    let mut ds: Vec<(f32, f32)> = pts
        .iter()
        .map(|p| {
            let dx = p[0] - x;
            let dz = p[2] - z;
            (dx * dx + dz * dz, p[1])
        })
        .collect();
    ds.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let take_n = k.min(ds.len()).max(1);
    let mut sum_w = 0.0f32;
    let mut sum_y = 0.0f32;
    for (d2, y) in ds.into_iter().take(take_n) {
        let w = 1.0 / (d2.sqrt() + 1.0e-3);
        sum_w += w;
        sum_y += y * w;
    }
    if sum_w > 0.0 {
        sum_y / sum_w
    } else {
        0.0
    }
}
