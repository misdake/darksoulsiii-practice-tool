use std::path::{Path, PathBuf};
use std::{collections::HashSet, fs};

use anyhow::{Context, Result};
use image::{Rgb, RgbImage};

use crate::common::{
    LevelIndex, TileIndex, TileRenderResult, BIN_TILE_DIM, FINEST_TILE_WORLD_SIZE,
    HOLE_ALERT_RADIUS, HOLE_FILL_ITERS, SCALE_WORLD_UNITS_PER_PIXEL, TILE_SIZE_PX,
};
use crate::fs_utils::{decode_coord, encode_coord, file_name_utf8};
use crate::stage2_bin_split::read_ds3bin;

pub fn render_bins_to_tile_pyramid(
    bins_root: &Path,
    tiles_root: &Path,
    alerts_path: &Path,
    index_path: &Path,
) -> Result<()> {
    let mut alerts = String::from("z,tile_x,tile_y,hole_pixels_after_fill,coverage\n");
    let bins = find_bin_dirs(bins_root)?;
    let bin_world_size = FINEST_TILE_WORLD_SIZE * BIN_TILE_DIM as f32;
    let z_max = SCALE_WORLD_UNITS_PER_PIXEL.len() - 1;
    let mut tile_index = TileIndex {
        tile_size_px: TILE_SIZE_PX,
        scales_world_units_per_pixel: SCALE_WORLD_UNITS_PER_PIXEL.to_vec(),
        levels: std::collections::BTreeMap::new(),
    };

    for bin_dir in bins {
        let name = file_name_utf8(&bin_dir)?;
        let (bx, by) = parse_bin_dir_name(&name)?;

        let mut points = Vec::new();
        for entry in
            fs::read_dir(&bin_dir).with_context(|| format!("read_dir {}", bin_dir.display()))?
        {
            let p = entry?.path();
            if p.extension().and_then(|e| e.to_str()) != Some("ds3bin") {
                continue;
            }
            points.extend(read_ds3bin(&p)?);
        }
        if points.is_empty() {
            continue;
        }

        let bin_min_x = bx as f32 * bin_world_size;
        let bin_min_z = by as f32 * bin_world_size;
        let bin_max_x = bin_min_x + bin_world_size;
        let bin_max_z = bin_min_z + bin_world_size;

        let units_per_px = SCALE_WORLD_UNITS_PER_PIXEL[z_max];
        let tile_world_size = TILE_SIZE_PX as f32 * units_per_px;
        let tx0 = (bin_min_x / tile_world_size).floor() as i32;
        let ty0 = (bin_min_z / tile_world_size).floor() as i32;
        let tx1 = ((bin_max_x - 1.0e-6) / tile_world_size).floor() as i32;
        let ty1 = ((bin_max_z - 1.0e-6) / tile_world_size).floor() as i32;

        for tx in tx0..=tx1 {
            for ty in ty0..=ty1 {
                let tile = render_tile(points.as_slice(), tx, ty, units_per_px);
                if tile.coverage < 0.0001 {
                    continue;
                }

                let x_name = encode_coord(tx);
                let y_name = encode_coord(ty);
                let z_name = z_max.to_string();
                let z_dir = tiles_root.join(&z_name).join(&x_name);
                fs::create_dir_all(&z_dir).with_context(|| format!("mkdir {}", z_dir.display()))?;
                let tile_path = z_dir.join(format!("{}.png", y_name));
                tile.image
                    .save(&tile_path)
                    .with_context(|| format!("save {}", tile_path.display()))?;

                add_tile_to_index(&mut tile_index, z_max, tx, ty);
                if tile.hole_pixels_after_fill > 0 {
                    alerts.push_str(&format!(
                        "{},{},{},{},{}\n",
                        z_max, tx, ty, tile.hole_pixels_after_fill, tile.coverage
                    ));
                }
            }
        }
    }

    for z in (0..z_max).rev() {
        let child_z = z + 1;
        let child_key = child_z.to_string();
        let Some(child_level) = tile_index.levels.get(&child_key) else {
            continue;
        };

        let mut coarse_coords: HashSet<(i32, i32)> = HashSet::new();
        for (x_name, ys) in &child_level.x {
            let Ok(cx) = decode_coord(x_name) else {
                continue;
            };
            for y_name in ys {
                let Ok(cy) = decode_coord(y_name) else {
                    continue;
                };
                coarse_coords.insert((cx.div_euclid(2), cy.div_euclid(2)));
            }
        }

        for (tx, ty) in coarse_coords {
            if !build_coarse_tile_from_children(tiles_root, child_z, z, tx, ty)? {
                continue;
            }
            add_tile_to_index(&mut tile_index, z, tx, ty);
        }
    }

    fs::write(alerts_path, alerts).with_context(|| format!("write {}", alerts_path.display()))?;
    let json = serde_json::to_vec_pretty(&tile_index).context("serialize tile index")?;
    fs::write(index_path, json).with_context(|| format!("write {}", index_path.display()))?;
    Ok(())
}

fn add_tile_to_index(index: &mut TileIndex, z: usize, tx: i32, ty: i32) {
    let z_name = z.to_string();
    let tile_world_size = TILE_SIZE_PX as f32 * SCALE_WORLD_UNITS_PER_PIXEL[z];
    let level = index
        .levels
        .entry(z_name)
        .or_insert_with(|| LevelIndex { tile_world_size, x: std::collections::BTreeMap::new() });
    let x_name = encode_coord(tx);
    let y_name = encode_coord(ty);
    let ys = level.x.entry(x_name).or_default();
    if !ys.iter().any(|v| v == &y_name) {
        ys.push(y_name);
        ys.sort();
    }
}

fn build_coarse_tile_from_children(
    tiles_root: &Path,
    child_z: usize,
    z: usize,
    tx: i32,
    ty: i32,
) -> Result<bool> {
    let child_coords =
        [(tx * 2, ty * 2), (tx * 2 + 1, ty * 2), (tx * 2, ty * 2 + 1), (tx * 2 + 1, ty * 2 + 1)];

    let mut canvas = RgbImage::new(TILE_SIZE_PX * 2, TILE_SIZE_PX * 2);
    let mut has_any = false;

    for (i, (cx, cy)) in child_coords.iter().enumerate() {
        let x_name = encode_coord(*cx);
        let y_name = encode_coord(*cy);
        let child_path =
            tiles_root.join(child_z.to_string()).join(&x_name).join(format!("{}.png", y_name));
        if !child_path.is_file() {
            continue;
        }

        let child_img = image::open(&child_path)
            .with_context(|| format!("open {}", child_path.display()))?
            .to_rgb8();
        let ox = if i % 2 == 0 { 0 } else { TILE_SIZE_PX };
        let oy = if i < 2 { 0 } else { TILE_SIZE_PX };
        for y in 0..TILE_SIZE_PX {
            for x in 0..TILE_SIZE_PX {
                canvas.put_pixel(ox + x, oy + y, *child_img.get_pixel(x, y));
            }
        }
        has_any = true;
    }

    if !has_any {
        return Ok(false);
    }

    let mut out = RgbImage::new(TILE_SIZE_PX, TILE_SIZE_PX);
    for y in 0..TILE_SIZE_PX {
        for x in 0..TILE_SIZE_PX {
            let p00 = canvas.get_pixel(x * 2, y * 2).0;
            let p10 = canvas.get_pixel(x * 2 + 1, y * 2).0;
            let p01 = canvas.get_pixel(x * 2, y * 2 + 1).0;
            let p11 = canvas.get_pixel(x * 2 + 1, y * 2 + 1).0;
            let r = ((p00[0] as u16 + p10[0] as u16 + p01[0] as u16 + p11[0] as u16) / 4) as u8;
            let g = ((p00[1] as u16 + p10[1] as u16 + p01[1] as u16 + p11[1] as u16) / 4) as u8;
            let b = ((p00[2] as u16 + p10[2] as u16 + p01[2] as u16 + p11[2] as u16) / 4) as u8;
            out.put_pixel(x, y, Rgb([r, g, b]));
        }
    }

    let out_dir = tiles_root.join(z.to_string()).join(encode_coord(tx));
    fs::create_dir_all(&out_dir).with_context(|| format!("mkdir {}", out_dir.display()))?;
    out.save(out_dir.join(format!("{}.png", encode_coord(ty))))?;
    Ok(true)
}

fn render_tile(
    points: &[crate::common::CloudPoint],
    tx: i32,
    ty: i32,
    units_per_px: f32,
) -> TileRenderResult {
    let tile_world_size = TILE_SIZE_PX as f32 * units_per_px;
    let tile_min_x = tx as f32 * tile_world_size;
    let tile_min_z = ty as f32 * tile_world_size;
    let tile_max_x = tile_min_x + tile_world_size;
    let tile_max_z = tile_min_z + tile_world_size;

    let n = (TILE_SIZE_PX * TILE_SIZE_PX) as usize;
    let mut sum_r = vec![0.0_f32; n];
    let mut sum_g = vec![0.0_f32; n];
    let mut sum_b = vec![0.0_f32; n];
    let mut sum_w = vec![0.0_f32; n];
    let mut has_core = vec![false; n];

    for p in points {
        if p.x < tile_min_x || p.x >= tile_max_x || p.z < tile_min_z || p.z >= tile_max_z {
            continue;
        }

        let fx = (p.x - tile_min_x) / units_per_px;
        let fy = (p.z - tile_min_z) / units_per_px;
        let cx = fx.floor() as i32;
        let cy = fy.floor() as i32;

        for oy in -1..=1 {
            for ox in -1..=1 {
                let px = cx + ox;
                let py = cy + oy;
                if px < 0 || py < 0 || px >= TILE_SIZE_PX as i32 || py >= TILE_SIZE_PX as i32 {
                    continue;
                }
                let dx = fx - (px as f32 + 0.5);
                let dy = fy - (py as f32 + 0.5);
                let d2 = dx * dx + dy * dy;
                let w = (1.0 - d2 / 2.25).max(0.0);
                if w <= 0.0 {
                    continue;
                }
                let idx = py as usize * TILE_SIZE_PX as usize + px as usize;
                sum_r[idx] += p.r * w;
                sum_g[idx] += p.g * w;
                sum_b[idx] += p.b * w;
                sum_w[idx] += w;
                if ox == 0 && oy == 0 {
                    has_core[idx] = true;
                }
            }
        }
    }

    let mut has_value = vec![false; n];
    for i in 0..n {
        has_value[i] = sum_w[i] > 0.0;
    }

    for _ in 0..HOLE_FILL_ITERS {
        let prev_has = has_value.clone();
        let prev_r = sum_r.clone();
        let prev_g = sum_g.clone();
        let prev_b = sum_b.clone();
        let prev_w = sum_w.clone();

        for y in 0..TILE_SIZE_PX as i32 {
            for x in 0..TILE_SIZE_PX as i32 {
                let idx = y as usize * TILE_SIZE_PX as usize + x as usize;
                if prev_has[idx] {
                    continue;
                }
                let mut ar = 0.0;
                let mut ag = 0.0;
                let mut ab = 0.0;
                let mut aw = 0.0;
                for (ox, oy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                    let nx = x + ox;
                    let ny = y + oy;
                    if nx < 0 || ny < 0 || nx >= TILE_SIZE_PX as i32 || ny >= TILE_SIZE_PX as i32 {
                        continue;
                    }
                    let nidx = ny as usize * TILE_SIZE_PX as usize + nx as usize;
                    if !prev_has[nidx] {
                        continue;
                    }
                    ar += prev_r[nidx] / prev_w[nidx];
                    ag += prev_g[nidx] / prev_w[nidx];
                    ab += prev_b[nidx] / prev_w[nidx];
                    aw += 1.0;
                }
                if aw > 0.0 {
                    sum_r[idx] = ar / aw;
                    sum_g[idx] = ag / aw;
                    sum_b[idx] = ab / aw;
                    sum_w[idx] = 1.0;
                    has_value[idx] = true;
                }
            }
        }
    }

    let mut holes_after_fill = 0usize;
    let mut covered = 0usize;
    let mut out = RgbImage::new(TILE_SIZE_PX, TILE_SIZE_PX);

    for y in 0..TILE_SIZE_PX as i32 {
        for x in 0..TILE_SIZE_PX as i32 {
            let idx = y as usize * TILE_SIZE_PX as usize + x as usize;
            if has_value[idx] {
                covered += 1;
                let rr = (sum_r[idx] / sum_w[idx]).clamp(0.0, 1.0);
                let gg = (sum_g[idx] / sum_w[idx]).clamp(0.0, 1.0);
                let bb = (sum_b[idx] / sum_w[idx]).clamp(0.0, 1.0);
                out.put_pixel(
                    x as u32,
                    y as u32,
                    Rgb([
                        linear_f32_to_srgb_u8(rr),
                        linear_f32_to_srgb_u8(gg),
                        linear_f32_to_srgb_u8(bb),
                    ]),
                );
            } else if has_neighbor_within(&has_core, x, y, HOLE_ALERT_RADIUS) {
                holes_after_fill += 1;
                out.put_pixel(x as u32, y as u32, Rgb([255, 0, 255]));
            } else {
                out.put_pixel(x as u32, y as u32, Rgb([0, 0, 0]));
            }
        }
    }

    TileRenderResult {
        image: out,
        coverage: covered as f32 / n as f32,
        hole_pixels_after_fill: holes_after_fill,
    }
}

fn linear_f32_to_srgb_u8(v: f32) -> u8 {
    let s = if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    (s.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn has_neighbor_within(mask: &[bool], x: i32, y: i32, radius: i32) -> bool {
    for oy in -radius..=radius {
        for ox in -radius..=radius {
            let nx = x + ox;
            let ny = y + oy;
            if nx < 0 || ny < 0 || nx >= TILE_SIZE_PX as i32 || ny >= TILE_SIZE_PX as i32 {
                continue;
            }
            let idx = ny as usize * TILE_SIZE_PX as usize + nx as usize;
            if mask[idx] {
                return true;
            }
        }
    }
    false
}

fn find_bin_dirs(bins_root: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in
        fs::read_dir(bins_root).with_context(|| format!("read_dir {}", bins_root.display()))?
    {
        let p = entry?.path();
        if p.is_dir() {
            out.push(p);
        }
    }
    out.sort();
    Ok(out)
}

fn parse_bin_dir_name(name: &str) -> Result<(i32, i32)> {
    let rest =
        name.strip_prefix("bin_").with_context(|| format!("invalid bin dir name: {}", name))?;
    let mut it = rest.split('_');
    let bx = decode_coord(it.next().context("missing bx")?)?;
    let by = decode_coord(it.next().context("missing by")?)?;
    Ok((bx, by))
}
