use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

use crate::common::TILE_SIZE_PX;
use crate::fs_utils::find_all_toml_in_capture;

pub(super) const MASK_EXPAND_WORLD: f32 = 2.0;

#[derive(Deserialize)]
struct WalkableLoopsFile {
    loops: Vec<Vec<[f32; 3]>>,
}

#[derive(Serialize)]
struct WalkableLoopsMerged {
    version: u32,
    loops: Vec<Vec<[f32; 3]>>,
    expand_world: f32,
}

#[derive(Clone)]
pub(super) struct WalkableMask {
    pub(super) loops_xz: Vec<Vec<[f32; 2]>>,
    pub(super) loop_bounds: Vec<LoopBounds>,
}

#[derive(Clone, Copy)]
pub(super) struct LoopBounds {
    pub(super) min_x: f32,
    pub(super) max_x: f32,
    pub(super) min_z: f32,
    pub(super) max_z: f32,
}

pub(super) type TileWalkableMask = HashMap<(i32, i32), Vec<bool>>;

pub(super) fn load_walkable_mask(capture_dir: &Path) -> Result<WalkableMask> {
    let mut loops_xz: Vec<Vec<[f32; 2]>> = Vec::new();
    let tomls = find_all_toml_in_capture(capture_dir)?;
    let mut seen_dirs = std::collections::HashSet::new();
    for toml in tomls {
        let Some(dir) = toml.parent() else { continue };
        if !seen_dirs.insert(dir.to_path_buf()) {
            continue;
        }
        let p = dir.join("walkable_loops.json");
        if !p.is_file() {
            continue;
        }
        let bytes = std::fs::read(&p).with_context(|| format!("read {}", p.display()))?;
        let parsed: WalkableLoopsFile =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", p.display()))?;
        for lp in parsed.loops {
            if lp.len() < 3 {
                continue;
            }
            loops_xz.push(lp.into_iter().map(|v| [v[0], -v[2]]).collect());
        }
    }
    let mut loop_bounds = Vec::with_capacity(loops_xz.len());
    for lp in &loops_xz {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_z = f32::INFINITY;
        let mut max_z = f32::NEG_INFINITY;
        for p in lp {
            min_x = min_x.min(p[0]);
            max_x = max_x.max(p[0]);
            min_z = min_z.min(p[1]);
            max_z = max_z.max(p[1]);
        }
        loop_bounds.push(LoopBounds { min_x, max_x, min_z, max_z });
    }
    Ok(WalkableMask { loops_xz, loop_bounds })
}

pub(super) fn write_merged_walkable_file(tiles_root: &Path, mask: &WalkableMask) -> Result<()> {
    let loops =
        mask.loops_xz.iter().map(|lp| lp.iter().map(|p| [p[0], 0.0, p[1]]).collect()).collect();
    let out = WalkableLoopsMerged { version: 1, loops, expand_world: MASK_EXPAND_WORLD };
    let bytes = serde_json::to_vec_pretty(&out).context("serialize merged walkable loops")?;
    std::fs::write(tiles_root.join("walkable_loops_merged.json"), bytes)
        .context("write merged walkable loops")?;
    Ok(())
}

pub(super) fn apply_walkable_mask(
    img: &mut RgbaImage,
    tx: i32,
    ty: i32,
    units_per_px: f32,
    mask: &WalkableMask,
    precomputed_mask: Option<&[bool]>,
) {
    if let Some(mask_bits) = precomputed_mask {
        for py in 0..TILE_SIZE_PX {
            for px in 0..TILE_SIZE_PX {
                let idx = py as usize * TILE_SIZE_PX as usize + px as usize;
                if !mask_bits[idx] {
                    img.put_pixel(px, py, Rgba([0, 0, 0, 0]));
                }
            }
        }
        return;
    }
    if mask.loops_xz.is_empty() {
        return;
    }
    let tile_world_size = TILE_SIZE_PX as f32 * units_per_px;
    let min_x = tx as f32 * tile_world_size;
    let min_z = ty as f32 * tile_world_size;

    for py in 0..TILE_SIZE_PX {
        for px in 0..TILE_SIZE_PX {
            let wx = min_x + (px as f32 + 0.5) * units_per_px;
            let wz = min_z + (py as f32 + 0.5) * units_per_px;
            if !point_in_or_near_loops(wx, wz, &mask.loops_xz, MASK_EXPAND_WORLD) {
                img.put_pixel(px, py, Rgba([0, 0, 0, 0]));
            }
        }
    }
}

pub(super) fn rasterize_walkable_mask_tile(
    mask: &WalkableMask,
    tx: i32,
    ty: i32,
    units_per_px: f32,
) -> Vec<bool> {
    let tile_world_size = TILE_SIZE_PX as f32 * units_per_px;
    let min_x = tx as f32 * tile_world_size;
    let min_z = ty as f32 * tile_world_size;
    let max_x = min_x + tile_world_size;
    let max_z = min_z + tile_world_size;
    let expand = MASK_EXPAND_WORLD;
    let mut candidates: Vec<usize> = Vec::new();
    for (i, b) in mask.loop_bounds.iter().enumerate() {
        if b.max_x + expand < min_x
            || b.min_x - expand > max_x
            || b.max_z + expand < min_z
            || b.min_z - expand > max_z
        {
            continue;
        }
        candidates.push(i);
    }

    let mut bits = vec![false; (TILE_SIZE_PX * TILE_SIZE_PX) as usize];
    if candidates.is_empty() {
        return bits;
    }

    for &li in &candidates {
        let poly = &mask.loops_xz[li];
        if poly.len() < 3 {
            continue;
        }
        for py in 0..TILE_SIZE_PX as i32 {
            let wz = min_z + (py as f32 + 0.5) * units_per_px;
            let mut xs: Vec<f32> = Vec::new();
            for i in 0..poly.len() {
                let a = poly[i];
                let b = poly[(i + 1) % poly.len()];
                let (x0, z0) = (a[0], a[1]);
                let (x1, z1) = (b[0], b[1]);
                if (z0 > wz) == (z1 > wz) {
                    continue;
                }
                let t = (wz - z0) / (z1 - z0 + 1.0e-12);
                xs.push(x0 + (x1 - x0) * t);
            }
            if xs.len() < 2 {
                continue;
            }
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let mut i = 0usize;
            while i + 1 < xs.len() {
                let mut px0 = ((xs[i] - min_x) / units_per_px).floor() as i32;
                let mut px1 = ((xs[i + 1] - min_x) / units_per_px).floor() as i32;
                if px0 > px1 {
                    std::mem::swap(&mut px0, &mut px1);
                }
                if px1 < 0 || px0 > TILE_SIZE_PX as i32 - 1 {
                    i += 2;
                    continue;
                }
                px0 = px0.clamp(0, TILE_SIZE_PX as i32 - 1);
                px1 = px1.clamp(0, TILE_SIZE_PX as i32 - 1);
                for px in px0..=px1 {
                    let idx = py as usize * TILE_SIZE_PX as usize + px as usize;
                    bits[idx] = true;
                }
                i += 2;
            }
        }
    }

    let mut expanded = bits;
    let e2 = expand * expand;
    for py in 0..TILE_SIZE_PX as i32 {
        for px in 0..TILE_SIZE_PX as i32 {
            let idx = py as usize * TILE_SIZE_PX as usize + px as usize;
            if expanded[idx] {
                continue;
            }
            let wx = min_x + (px as f32 + 0.5) * units_per_px;
            let wz = min_z + (py as f32 + 0.5) * units_per_px;
            let mut near = false;
            for &li in &candidates {
                let b = mask.loop_bounds[li];
                if wx < b.min_x - expand
                    || wx > b.max_x + expand
                    || wz < b.min_z - expand
                    || wz > b.max_z + expand
                {
                    continue;
                }
                let poly = &mask.loops_xz[li];
                for i in 0..poly.len() {
                    let a = poly[i];
                    let b = poly[(i + 1) % poly.len()];
                    if dist2_point_seg(wx, wz, a[0], a[1], b[0], b[1]) <= e2 {
                        near = true;
                        break;
                    }
                }
                if near {
                    break;
                }
            }
            if near {
                expanded[idx] = true;
            }
        }
    }
    expanded
}

pub(super) fn point_in_or_near_loops(x: f32, z: f32, loops: &[Vec<[f32; 2]>], expand: f32) -> bool {
    let e2 = expand * expand;
    for lp in loops {
        if point_in_polygon(x, z, lp) {
            return true;
        }
        for i in 0..lp.len() {
            let a = lp[i];
            let b = lp[(i + 1) % lp.len()];
            if dist2_point_seg(x, z, a[0], a[1], b[0], b[1]) <= e2 {
                return true;
            }
        }
    }
    false
}

fn point_in_polygon(x: f32, z: f32, poly: &[[f32; 2]]) -> bool {
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let xi = poly[i][0];
        let zi = poly[i][1];
        let xj = poly[j][0];
        let zj = poly[j][1];
        let intersect = ((zi > z) != (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi + 1.0e-12) + xi);
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn dist2_point_seg(px: f32, pz: f32, ax: f32, az: f32, bx: f32, bz: f32) -> f32 {
    let abx = bx - ax;
    let abz = bz - az;
    let apx = px - ax;
    let apz = pz - az;
    let d = abx * abx + abz * abz;
    if d <= 1.0e-12 {
        return apx * apx + apz * apz;
    }
    let t = ((apx * abx + apz * abz) / d).clamp(0.0, 1.0);
    let qx = ax + t * abx;
    let qz = az + t * abz;
    let dx = px - qx;
    let dz = pz - qz;
    dx * dx + dz * dz
}
