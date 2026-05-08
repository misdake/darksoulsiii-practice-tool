use image::{Rgb, RgbImage};

use crate::common::{CloudPoint, HOLE_ALERT_RADIUS, HOLE_FILL_ITERS, TILE_SIZE_PX};

const TOPK_PER_PIXEL: usize = 5;
const TOP1_DISTANCE_SIGMA_METERS: f32 = 0.055;
const SSAA_FACTOR: i32 = 2;

#[derive(Clone, Copy)]
struct TopKEntry {
    x: f32,
    y: f32,
    z: f32,
    r: f32,
    g: f32,
    b: f32,
    splat_w: f32,
}

impl Default for TopKEntry {
    fn default() -> Self {
        Self { x: 0.0, y: f32::NEG_INFINITY, z: 0.0, r: 0.0, g: 0.0, b: 0.0, splat_w: 0.0 }
    }
}

#[derive(Clone, Copy, Default)]
struct PixelTopK {
    count: u8,
    entries: [TopKEntry; TOPK_PER_PIXEL],
}

pub(super) struct TileRenderAccum {
    topk: Vec<PixelTopK>,
    has_core: Vec<bool>,
    ssaa_w: i32,
    ssaa_h: i32,
}

pub(super) fn new_tile_render_accum() -> TileRenderAccum {
    let ssaa_w = TILE_SIZE_PX as i32 * SSAA_FACTOR;
    let ssaa_h = TILE_SIZE_PX as i32 * SSAA_FACTOR;
    TileRenderAccum {
        topk: vec![PixelTopK::default(); (ssaa_w * ssaa_h) as usize],
        has_core: vec![false; (TILE_SIZE_PX * TILE_SIZE_PX) as usize],
        ssaa_w,
        ssaa_h,
    }
}

pub(super) fn accumulate_points_for_tile(
    accum: &mut TileRenderAccum,
    points: &[CloudPoint],
    tx: i32,
    ty: i32,
    units_per_px: f32,
) {
    let tile_world_size = TILE_SIZE_PX as f32 * units_per_px;
    let tile_min_x = tx as f32 * tile_world_size;
    let tile_min_z = ty as f32 * tile_world_size;
    let tile_max_x = tile_min_x + tile_world_size;
    let tile_max_z = tile_min_z + tile_world_size;

    for p in points {
        if p.x < tile_min_x || p.x >= tile_max_x || p.z < tile_min_z || p.z >= tile_max_z {
            continue;
        }

        let fx = (p.x - tile_min_x) / units_per_px;
        let fy = (p.z - tile_min_z) / units_per_px;

        let bx = fx.floor() as i32;
        let by = fy.floor() as i32;
        if bx >= 0 && by >= 0 && bx < TILE_SIZE_PX as i32 && by < TILE_SIZE_PX as i32 {
            let bidx = by as usize * TILE_SIZE_PX as usize + bx as usize;
            accum.has_core[bidx] = true;
        }

        let ssx = (fx * SSAA_FACTOR as f32).floor() as i32;
        let ssy = (fy * SSAA_FACTOR as f32).floor() as i32;
        if ssx < 0 || ssy < 0 || ssx >= accum.ssaa_w || ssy >= accum.ssaa_h {
            continue;
        }
        let sidx = ssy as usize * accum.ssaa_w as usize + ssx as usize;
        insert_topk_by_height(
            &mut accum.topk[sidx],
            TopKEntry { x: p.x, y: p.y, z: p.z, r: p.r, g: p.g, b: p.b, splat_w: 1.0 },
        );
    }
}

pub(super) fn render_tile_from_accum(accum: TileRenderAccum) -> crate::common::TileRenderResult {
    let n = (TILE_SIZE_PX * TILE_SIZE_PX) as usize;
    let mut sum_r = vec![0.0_f32; n];
    let mut sum_g = vec![0.0_f32; n];
    let mut sum_b = vec![0.0_f32; n];
    let mut sum_w = vec![0.0_f32; n];
    let sigma2 = TOP1_DISTANCE_SIGMA_METERS * TOP1_DISTANCE_SIGMA_METERS;
    let inv_2sigma2 = 0.5 / sigma2.max(1.0e-6);
    for y in 0..TILE_SIZE_PX as i32 {
        for x in 0..TILE_SIZE_PX as i32 {
            let idx = y as usize * TILE_SIZE_PX as usize + x as usize;
            let mut ar = 0.0_f32;
            let mut ag = 0.0_f32;
            let mut ab = 0.0_f32;
            let mut sub_count = 0.0_f32;

            for sy in 0..SSAA_FACTOR {
                for sx in 0..SSAA_FACTOR {
                    let ssx = x * SSAA_FACTOR + sx;
                    let ssy = y * SSAA_FACTOR + sy;
                    let sidx = ssy as usize * accum.ssaa_w as usize + ssx as usize;
                    let count = accum.topk[sidx].count as usize;
                    if count == 0 {
                        continue;
                    }
                    let top1 = accum.topk[sidx].entries[0];
                    let mut sr = 0.0_f32;
                    let mut sg = 0.0_f32;
                    let mut sb = 0.0_f32;
                    let mut sw = 0.0_f32;
                    for j in 0..count {
                        let e = accum.topk[sidx].entries[j];
                        let dx = e.x - top1.x;
                        let dy = e.y - top1.y;
                        let dz = e.z - top1.z;
                        let d2 = dx * dx + dy * dy + dz * dz;
                        let w_dist = (-d2 * inv_2sigma2).exp();
                        let w = e.splat_w * w_dist;
                        if w <= 0.0 {
                            continue;
                        }
                        sr += e.r * w;
                        sg += e.g * w;
                        sb += e.b * w;
                        sw += w;
                    }
                    if sw > 0.0 {
                        ar += sr / sw;
                        ag += sg / sw;
                        ab += sb / sw;
                        sub_count += 1.0;
                    }
                }
            }

            if sub_count > 0.0 {
                sum_r[idx] = ar / sub_count;
                sum_g[idx] = ag / sub_count;
                sum_b[idx] = ab / sub_count;
                sum_w[idx] = 1.0;
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
            } else if has_neighbor_within(&accum.has_core, x, y, HOLE_ALERT_RADIUS) {
                holes_after_fill += 1;
                out.put_pixel(x as u32, y as u32, Rgb([255, 0, 255]));
            } else {
                out.put_pixel(x as u32, y as u32, Rgb([0, 0, 0]));
            }
        }
    }

    crate::common::TileRenderResult {
        image: out,
        coverage: covered as f32 / n as f32,
        hole_pixels_after_fill: holes_after_fill,
    }
}

pub(super) fn srgb_u8_to_linear_f32(v: u8) -> f32 {
    let s = v as f32 / 255.0;
    if s <= 0.04045 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
}

pub(super) fn is_all_black(img: &RgbImage) -> bool {
    img.pixels().all(|p| p.0 == [0, 0, 0])
}

fn insert_topk_by_height(buf: &mut PixelTopK, entry: TopKEntry) {
    let count = buf.count as usize;
    if count == 0 {
        buf.entries[0] = entry;
        buf.count = 1;
        return;
    }

    let mut insert_at = count;
    for i in 0..count {
        if entry.y > buf.entries[i].y {
            insert_at = i;
            break;
        }
    }

    if count < TOPK_PER_PIXEL {
        if insert_at == count {
            buf.entries[count] = entry;
        } else {
            for j in (insert_at..count).rev() {
                buf.entries[j + 1] = buf.entries[j];
            }
            buf.entries[insert_at] = entry;
        }
        buf.count = (count + 1) as u8;
        return;
    }

    if insert_at >= TOPK_PER_PIXEL {
        return;
    }
    for j in (insert_at..(TOPK_PER_PIXEL - 1)).rev() {
        buf.entries[j + 1] = buf.entries[j];
    }
    buf.entries[insert_at] = entry;
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
