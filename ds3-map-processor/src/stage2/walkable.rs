use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::coord_space::{convert_z, parse_coord_space, CoordSpace};
use crate::geom::dist2_point_seg;

pub(super) const MASK_EXPAND_WORLD: f32 = 2.0;
const LOOP_MIN_EDGE_WORLD: f32 = 0.01;
const LOOP_COLLINEAR_DIST_WORLD: f32 = 0.015;
const LOOP_COLLINEAR_ANGLE_SIN: f32 = 0.02;
const LOOP_RDP_EPS_WORLD: f32 = 0.02;

#[derive(Deserialize)]
struct TrajectoryFile {
    #[serde(default)]
    coord_space: String,
    loops: Vec<Vec<[f32; 3]>>,
    #[allow(dead_code)]
    polylines: Option<Vec<Vec<[f32; 3]>>>,
}

#[derive(Serialize)]
struct WalkableLoopsSimplified {
    coord_space: String,
    version: u32,
    loops: Vec<Vec<[f32; 3]>>,
    expand_world: f32,
}

#[derive(Clone)]
pub(super) struct WalkableMask {
    pub(super) loops_simplified: Vec<Vec<[f32; 3]>>,
}

pub(super) fn load_walkable_mask(capture_dir: &Path) -> Result<WalkableMask> {
    let mut loops_simplified: Vec<Vec<[f32; 3]>> = Vec::new();
    let mut raw_points = 0usize;
    let mut simp_points = 0usize;
    let mut dirs = Vec::new();
    collect_dirs_recursive(capture_dir, &mut dirs)?;
    dirs.push(capture_dir.to_path_buf());
    dirs.sort();
    dirs.dedup();
    for dir in dirs {
        let p = dir.join("trajectory.json");
        if !p.is_file() {
            continue;
        }
        let parsed: TrajectoryFile = serde_json::from_str(
            &std::fs::read_to_string(&p).with_context(|| format!("read {}", p.display()))?,
        )
        .with_context(|| format!("parse {}", p.display()))?;
        let src_space = parse_coord_space(&parsed.coord_space);
        for lp in parsed.loops {
            if lp.len() < 3 {
                continue;
            }
            let raw3 = lp;
            let raw: Vec<[f32; 2]> = raw3
                .iter()
                .map(|v| [v[0], -convert_z(v[2], src_space, CoordSpace::Game)])
                .collect();
            raw_points += raw.len();
            let simp = simplify_loop_xz(&raw);
            if simp.len() < 3 {
                continue;
            }
            simp_points += simp.len();
            let mut simp3 = Vec::with_capacity(simp.len());
            for p in &simp {
                if let Some(y) = nearest_y_on_xz(p[0], p[1], &raw3, src_space) {
                    simp3.push([p[0], y, p[1]]);
                }
            }
            if simp3.len() >= 3 {
                loops_simplified.push(simp3);
            }
        }
    }
    if raw_points > 0 {
        let ratio = simp_points as f32 / raw_points as f32 * 100.0;
        println!(
            "  walkable loop simplify: {} -> {} points ({:.1}%)",
            raw_points, simp_points, ratio
        );
    }
    Ok(WalkableMask { loops_simplified })
}

fn collect_dirs_recursive(root: &Path, out: &mut Vec<std::path::PathBuf>) -> Result<()> {
    if !root.is_dir() {
        return Ok(());
    }
    for e in std::fs::read_dir(root).with_context(|| format!("read_dir {}", root.display()))? {
        let p = e?.path();
        if p.is_dir() {
            out.push(p.clone());
            collect_dirs_recursive(&p, out)?;
        }
    }
    Ok(())
}

pub(super) fn write_merged_walkable_file(tiles_root: &Path, mask: &WalkableMask) -> Result<()> {
    let out = WalkableLoopsSimplified {
        coord_space: CoordSpace::Processor.as_str().to_string(),
        version: 1,
        loops: mask.loops_simplified.clone(),
        expand_world: MASK_EXPAND_WORLD,
    };
    let bytes = serde_json::to_vec_pretty(&out).context("serialize simplified walkable loops")?;
    std::fs::write(tiles_root.join("trajectory_simplified.json"), bytes)
        .context("write simplified walkable loops")?;
    Ok(())
}

fn nearest_y_on_xz(x: f32, z_proc: f32, src: &[[f32; 3]], src_space: CoordSpace) -> Option<f32> {
    let mut best: Option<(f32, f32)> = None;
    for &p in src {
        let dz_proc = -convert_z(p[2], src_space, CoordSpace::Game);
        let dx = p[0] - x;
        let dz = dz_proc - z_proc;
        let d2 = dx * dx + dz * dz;
        match best {
            Some((_, bd2)) if bd2 <= d2 => {},
            _ => best = Some((p[1], d2)),
        }
    }
    best.map(|v| v.0)
}

fn simplify_loop_xz(points: &[[f32; 2]]) -> Vec<[f32; 2]> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut cleaned = remove_near_duplicates(points, LOOP_MIN_EDGE_WORLD);
    if cleaned.len() < 3 {
        return cleaned;
    }
    cleaned = remove_near_collinear(&cleaned, LOOP_COLLINEAR_DIST_WORLD, LOOP_COLLINEAR_ANGLE_SIN);
    if cleaned.len() < 3 {
        return cleaned;
    }
    cleaned = rdp_closed_polygon(&cleaned, LOOP_RDP_EPS_WORLD);
    if cleaned.len() < 3 {
        return cleaned;
    }
    remove_near_collinear(&cleaned, LOOP_COLLINEAR_DIST_WORLD, LOOP_COLLINEAR_ANGLE_SIN)
}

fn remove_near_duplicates(points: &[[f32; 2]], min_edge_world: f32) -> Vec<[f32; 2]> {
    let min_edge2 = min_edge_world * min_edge_world;
    let mut out: Vec<[f32; 2]> = Vec::with_capacity(points.len());
    for &p in points {
        if let Some(&last) = out.last() {
            let dx = p[0] - last[0];
            let dz = p[1] - last[1];
            if dx * dx + dz * dz <= min_edge2 {
                continue;
            }
        }
        out.push(p);
    }
    while out.len() >= 2 {
        let a = out[0];
        let b = *out.last().expect("out not empty");
        let dx = a[0] - b[0];
        let dz = a[1] - b[1];
        if dx * dx + dz * dz > min_edge2 {
            break;
        }
        out.pop();
    }
    out
}

fn remove_near_collinear(points: &[[f32; 2]], dist_eps: f32, sin_eps: f32) -> Vec<[f32; 2]> {
    if points.len() < 4 {
        return points.to_vec();
    }
    let mut out = points.to_vec();
    let dist_eps2 = dist_eps * dist_eps;
    let mut changed = true;
    while changed && out.len() >= 4 {
        changed = false;
        let n = out.len();
        let mut keep = vec![true; n];
        for i in 0..n {
            let prev = out[(i + n - 1) % n];
            let cur = out[i];
            let next = out[(i + 1) % n];

            let vx0 = cur[0] - prev[0];
            let vz0 = cur[1] - prev[1];
            let vx1 = next[0] - cur[0];
            let vz1 = next[1] - cur[1];
            let len0 = (vx0 * vx0 + vz0 * vz0).sqrt();
            let len1 = (vx1 * vx1 + vz1 * vz1).sqrt();
            if len0 <= 1.0e-6 || len1 <= 1.0e-6 {
                keep[i] = false;
                changed = true;
                continue;
            }
            let cross = (vx0 * vz1 - vz0 * vx1).abs() / (len0 * len1 + 1.0e-12);
            if cross > sin_eps {
                continue;
            }
            if dist2_point_seg(cur[0], cur[1], prev[0], prev[1], next[0], next[1]) <= dist_eps2 {
                keep[i] = false;
                changed = true;
            }
        }
        if changed {
            out = out.into_iter().enumerate().filter_map(|(i, p)| keep[i].then_some(p)).collect();
        }
    }
    out
}

fn rdp_closed_polygon(points: &[[f32; 2]], eps: f32) -> Vec<[f32; 2]> {
    if points.len() < 4 {
        return points.to_vec();
    }
    let mut max_d2 = -1.0f32;
    let mut seed = 0usize;
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + points.len() / 2) % points.len()];
        let dx = a[0] - b[0];
        let dz = a[1] - b[1];
        let d2 = dx * dx + dz * dz;
        if d2 > max_d2 {
            max_d2 = d2;
            seed = i;
        }
    }
    let n = points.len();
    let mut opened = Vec::with_capacity(n + 1);
    for k in 0..n {
        opened.push(points[(seed + k) % n]);
    }
    opened.push(opened[0]);

    let keep = rdp_open_keep_mask(&opened, eps);
    let mut out = Vec::with_capacity(n);
    for (i, p) in opened.into_iter().enumerate().take(n) {
        if keep[i] {
            out.push(p);
        }
    }
    if out.len() < 3 {
        points.to_vec()
    } else {
        out
    }
}

fn rdp_open_keep_mask(points: &[[f32; 2]], eps: f32) -> Vec<bool> {
    let n = points.len();
    let mut keep = vec![false; n];
    if n == 0 {
        return keep;
    }
    keep[0] = true;
    keep[n - 1] = true;
    if n <= 2 {
        return keep;
    }
    let mut stack = vec![(0usize, n - 1usize)];
    let eps2 = eps * eps;
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let pa = points[a];
        let pb = points[b];
        let mut best_i = 0usize;
        let mut best_d2 = -1.0f32;
        for (i, p) in points.iter().enumerate().take(b).skip(a + 1) {
            let d2 = dist2_point_seg(p[0], p[1], pa[0], pa[1], pb[0], pb[1]);
            if d2 > best_d2 {
                best_d2 = d2;
                best_i = i;
            }
        }
        if best_d2 > eps2 {
            keep[best_i] = true;
            stack.push((a, best_i));
            stack.push((best_i, b));
        }
    }
    keep
}
