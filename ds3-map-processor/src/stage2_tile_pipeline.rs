use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::{collections::HashMap, collections::HashSet, fs};

use anyhow::{Context, Result};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ColorType, Rgb, RgbImage};
use serde::{Deserialize, Serialize};

use crate::common::{
    CAPTURE_CACHE_BYTES, CaptureData, CloudPoint, HOLE_ALERT_RADIUS, HOLE_FILL_ITERS, LevelIndex, MAX_POINT_BYTES_IN_FLIGHT, SCALE_WORLD_UNITS_PER_PIXEL, TILE_SIZE_PX,
    TileIndex, TileRenderResult,
};
use crate::fs_utils::{encode_coord, find_all_toml_in_capture};
use crate::stage1_pointcloud::{
    iter_points_in_aabb_for_tile, load_capture_from_toml, parse_tile_key, read_tile_pixel_index,
};
use crate::task_budget::run_with_budget;

const MASK_EXPAND_WORLD: f32 = 2.0;
const JPEG_QUALITY: u8 = 95;

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
struct WalkableMask {
    loops_xz: Vec<Vec<[f32; 2]>>,
}

pub struct Stage2BudgetStats {
    pub point_inflight_peak_bytes: usize,
    pub capture_cache_peak_bytes: usize,
}

#[derive(Clone)]
struct CachedCapture {
    data: Arc<CaptureData>,
    bytes: usize,
    last_used_tick: u64,
}

struct CaptureLru {
    budget_bytes: usize,
    used_bytes: usize,
    peak_used_bytes: usize,
    tick: u64,
    map: HashMap<String, CachedCapture>,
}

pub fn render_tiles_to_pyramid(
    capture_dir: &Path,
    tile_pixel_index_path: &Path,
    tiles_root: &Path,
    alerts_path: &Path,
    index_path: &Path,
) -> Result<Stage2BudgetStats> {
    let mask = load_walkable_mask(capture_dir)?;
    write_merged_walkable_file(tiles_root, &mask)?;
    let capture_cache = Arc::new(Mutex::new(CaptureLru {
        budget_bytes: CAPTURE_CACHE_BYTES,
        used_bytes: 0,
        peak_used_bytes: 0,
        tick: 0,
        map: HashMap::new(),
    }));

    let mut alerts = String::from("z,tile_x,tile_y,hole_pixels_after_fill,coverage\n");
    let z_max = SCALE_WORLD_UNITS_PER_PIXEL.len() - 1;
    let mut tile_index = TileIndex {
        tile_size_px: TILE_SIZE_PX,
        image_ext: "jpg".to_string(),
        scales_world_units_per_pixel: SCALE_WORLD_UNITS_PER_PIXEL.to_vec(),
        levels: std::collections::BTreeMap::new(),
    };

    let tile_pixel_index = read_tile_pixel_index(tile_pixel_index_path)?;
    let mut finest_tasks: Vec<(i32, i32, Vec<crate::common::TilePixelRef>)> = Vec::new();
    for (k, refs) in tile_pixel_index.tiles {
        let (tx, ty) = parse_tile_key(&k)?;
        finest_tasks.push((tx, ty, refs));
    }
    finest_tasks.sort_by_key(|(tx, ty, _)| (*tx, *ty));
    let total_tiles = finest_tasks.len();
    println!("Stage 2/2 finest render: {} tile(s).", total_tiles);

    let completed = Arc::new(AtomicUsize::new(0));
    let finest_hits: Arc<Mutex<Vec<(i32, i32)>>> = Arc::new(Mutex::new(Vec::new()));
    let alert_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let finest_tiles_root = tiles_root.to_path_buf();
    let finest_hits_in_task = Arc::clone(&finest_hits);
    let alert_lines_in_task = Arc::clone(&alert_lines);
    let mask_in_task = mask.clone();
    let cache_in_task = Arc::clone(&capture_cache);
    let finest_peak_inflight = run_with_budget(
        finest_tasks,
        |(_, _, refs)| estimate_tile_refs_bytes(refs),
        MAX_POINT_BYTES_IN_FLIGHT,
        std::thread::available_parallelism().map_or(1usize, |n| n.get().max(1)),
        move |(tx, ty, refs), reserved_bytes| {
            let output = render_one_finest_tile(
                &refs,
                &finest_tiles_root,
                z_max,
                tx,
                ty,
                &mask_in_task,
                &cache_in_task,
            )?;

            if let Some(tile) = output {
                finest_hits_in_task.lock().expect("finest_hits poisoned").push((tx, ty));
                if tile.hole_pixels_after_fill > 0 {
                    alert_lines_in_task.lock().expect("alert_lines poisoned").push(format!(
                        "{},{},{},{},{}",
                        z_max, tx, ty, tile.hole_pixels_after_fill, tile.coverage
                    ));
                }
            }

            let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
            let pct =
                if total_tiles == 0 { 100.0 } else { (done as f32 / total_tiles as f32) * 100.0 };
            println!(
                "  finest {}/{} ({:.1}%) in_flight={}MB",
                done,
                total_tiles,
                pct,
                reserved_bytes / (1024 * 1024)
            );
            Ok(())
        },
    )?;

    let mut stage2_point_peak = finest_peak_inflight;

    for (tx, ty) in finest_hits.lock().expect("finest_hits poisoned").iter().copied() {
        add_tile_to_index(&mut tile_index, z_max, tx, ty);
    }
    for line in alert_lines.lock().expect("alert_lines poisoned").iter() {
        alerts.push_str(line);
        alerts.push('\n');
    }

    for z in (0..z_max).rev() {
        let child_z = z + 1;
        let child_key = child_z.to_string();
        let Some(child_level) = tile_index.levels.get(&child_key) else {
            continue;
        };

        let mut coarse_coords: HashSet<(i32, i32)> = HashSet::new();
        for (x_name, ys) in &child_level.x {
            let Ok(cx) = x_name.parse::<i32>() else {
                continue;
            };
            for y_name in ys {
                let Ok(cy) = y_name.parse::<i32>() else {
                    continue;
                };
                coarse_coords.insert((cx.div_euclid(2), cy.div_euclid(2)));
            }
        }

        let mut coarse_vec: Vec<(i32, i32)> = coarse_coords.into_iter().collect();
        coarse_vec.sort();
        let total = coarse_vec.len();
        println!("  pyramid z={} from z={} : {} tile(s).", z, child_z, total);

        let level_done = Arc::new(AtomicUsize::new(0));
        let built_coords: Arc<Mutex<Vec<(i32, i32)>>> = Arc::new(Mutex::new(Vec::new()));
        let level_tiles_root = tiles_root.to_path_buf();
        let level_peak = run_with_budget(
            coarse_vec,
            |_| 1,
            MAX_POINT_BYTES_IN_FLIGHT,
            std::thread::available_parallelism().map_or(1usize, |n| n.get().max(1)),
            {
                let built_coords = Arc::clone(&built_coords);
                let level_done = Arc::clone(&level_done);
                move |(tx, ty), _| {
                    if build_coarse_tile_from_children(&level_tiles_root, child_z, z, tx, ty)? {
                        built_coords.lock().expect("built_coords poisoned").push((tx, ty));
                    }

                    let done = level_done.fetch_add(1, Ordering::SeqCst) + 1;
                    let pct = if total == 0 { 100.0 } else { (done as f32 / total as f32) * 100.0 };
                    println!("    z={} {}/{} ({:.1}%)", z, done, total, pct);
                    Ok(())
                }
            },
        )?;
        stage2_point_peak = stage2_point_peak.max(level_peak);

        for (tx, ty) in built_coords.lock().expect("built_coords poisoned").iter().copied() {
            add_tile_to_index(&mut tile_index, z, tx, ty);
        }
    }

    fs::write(alerts_path, alerts).with_context(|| format!("write {}", alerts_path.display()))?;
    let json = serde_json::to_vec_pretty(&tile_index).context("serialize tile index")?;
    fs::write(index_path, json).with_context(|| format!("write {}", index_path.display()))?;
    let capture_peak = capture_cache.lock().expect("capture_cache poisoned").peak_used_bytes;
    Ok(Stage2BudgetStats {
        point_inflight_peak_bytes: stage2_point_peak,
        capture_cache_peak_bytes: capture_peak,
    })
}

fn load_walkable_mask(capture_dir: &Path) -> Result<WalkableMask> {
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
        let bytes = fs::read(&p).with_context(|| format!("read {}", p.display()))?;
        let parsed: WalkableLoopsFile =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", p.display()))?;
        for lp in parsed.loops {
            if lp.len() < 3 {
                continue;
            }
            // Probe loop capture is raw world space; processor derived outputs are right-handed (z flipped).
            // Align walkable mask to the same right-handed space here.
            loops_xz.push(lp.into_iter().map(|v| [v[0], -v[2]]).collect());
        }
    }
    Ok(WalkableMask { loops_xz })
}

fn write_merged_walkable_file(tiles_root: &Path, mask: &WalkableMask) -> Result<()> {
    let loops =
        mask.loops_xz.iter().map(|lp| lp.iter().map(|p| [p[0], 0.0, p[1]]).collect()).collect();
    let out = WalkableLoopsMerged { version: 1, loops, expand_world: MASK_EXPAND_WORLD };
    let bytes = serde_json::to_vec_pretty(&out).context("serialize merged walkable loops")?;
    fs::write(tiles_root.join("walkable_loops_merged.json"), bytes)
        .context("write merged walkable loops")?;
    Ok(())
}

fn render_one_finest_tile(
    refs: &[crate::common::TilePixelRef],
    tiles_root: &Path,
    z_max: usize,
    tx: i32,
    ty: i32,
    mask: &WalkableMask,
    capture_cache: &Arc<Mutex<CaptureLru>>,
) -> Result<Option<TileRenderResult>> {
    let mut points = Vec::new();
    let tile_world_size = TILE_SIZE_PX as f32 * SCALE_WORLD_UNITS_PER_PIXEL[z_max];
    for r in refs {
        let capture = get_or_load_capture(capture_cache, &r.capture_toml)?;
        iter_points_in_aabb_for_tile(
            &capture,
            &r.aabb,
            tx,
            ty,
            tile_world_size,
            |wx, _wy, wz, rgb| {
                points.push(CloudPoint {
                    x: wx,
                    z: wz,
                    r: srgb_u8_to_linear_f32(rgb[0]),
                    g: srgb_u8_to_linear_f32(rgb[1]),
                    b: srgb_u8_to_linear_f32(rgb[2]),
                });
            },
        );
    }

    if points.is_empty() {
        return Ok(None);
    }

    let units_per_px = SCALE_WORLD_UNITS_PER_PIXEL[z_max];
    let mut tile = render_tile(points.as_slice(), tx, ty, units_per_px);
    apply_walkable_mask(&mut tile.image, tx, ty, units_per_px, mask);
    if tile.coverage < 0.0001 || is_all_black(&tile.image) {
        return Ok(None);
    }

    let x_name = encode_coord(tx);
    let y_name = encode_coord(ty);
    let z_name = z_max.to_string();
    let z_dir = tiles_root.join(&z_name).join(&x_name);
    fs::create_dir_all(&z_dir).with_context(|| format!("mkdir {}", z_dir.display()))?;
    let tile_path = z_dir.join(format!("{}.jpg", y_name));
    save_jpeg(&tile.image, &tile_path)?;

    Ok(Some(tile))
}

fn apply_walkable_mask(
    img: &mut RgbImage,
    tx: i32,
    ty: i32,
    units_per_px: f32,
    mask: &WalkableMask,
) {
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
                img.put_pixel(px, py, Rgb([0, 0, 0]));
            }
        }
    }
}

fn point_in_or_near_loops(x: f32, z: f32, loops: &[Vec<[f32; 2]>], expand: f32) -> bool {
    let e2 = expand * expand;
    for lp in loops {
        // Self-intersections are handled robustly enough for v1 by combining:
        // 1) odd-even inside test, and
        // 2) distance-to-edge expansion band.
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
        let intersect =
            ((zi > z) != (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi + 1.0e-12) + xi);
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

fn save_jpeg(img: &RgbImage, path: &Path) -> Result<()> {
    let file = fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    let mut enc = JpegEncoder::new_with_quality(file, JPEG_QUALITY);
    enc.encode(img.as_raw(), img.width(), img.height(), ColorType::Rgb8)
        .with_context(|| format!("encode jpeg {}", path.display()))?;
    Ok(())
}

fn estimate_tile_refs_bytes(refs: &[crate::common::TilePixelRef]) -> usize {
    let mut px = 0usize;
    for r in refs {
        px = px.saturating_add(r.aabb.pixel_count as usize);
    }
    // rough upper bound for decoded/color+depth working-set contribution
    (px.saturating_mul(24)).max(1)
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
            tiles_root.join(child_z.to_string()).join(&x_name).join(format!("{}.jpg", y_name));
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

    let out = image::imageops::resize(&canvas, TILE_SIZE_PX, TILE_SIZE_PX, FilterType::CatmullRom);

    let out_dir = tiles_root.join(z.to_string()).join(encode_coord(tx));
    fs::create_dir_all(&out_dir).with_context(|| format!("mkdir {}", out_dir.display()))?;
    let path = out_dir.join(format!("{}.jpg", encode_coord(ty)));
    save_jpeg(&out, &path)?;
    Ok(true)
}

fn render_tile(points: &[CloudPoint], tx: i32, ty: i32, units_per_px: f32) -> TileRenderResult {
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

fn srgb_u8_to_linear_f32(v: u8) -> f32 {
    let s = v as f32 / 255.0;
    if s <= 0.04045 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
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

fn is_all_black(img: &RgbImage) -> bool {
    img.pixels().all(|p| p.0 == [0, 0, 0])
}

fn capture_data_bytes(c: &CaptureData) -> usize {
    c.rgb.as_raw().len().saturating_add(c.depth.len().saturating_mul(4))
}

fn get_or_load_capture(cache: &Arc<Mutex<CaptureLru>>, toml_path: &str) -> Result<Arc<CaptureData>> {
    {
        let mut guard = cache.lock().expect("capture_cache poisoned");
        let tick = guard.tick.saturating_add(1);
        guard.tick = tick;
        if let Some(e) = guard.map.get_mut(toml_path) {
            e.last_used_tick = tick;
            return Ok(Arc::clone(&e.data));
        }
    }

    let loaded = Arc::new(load_capture_from_toml(Path::new(toml_path))?);
    let loaded_bytes = capture_data_bytes(&loaded);

    let mut guard = cache.lock().expect("capture_cache poisoned");
    let tick = guard.tick.saturating_add(1);
    guard.tick = tick;
    if let Some(e) = guard.map.get_mut(toml_path) {
        e.last_used_tick = tick;
        return Ok(Arc::clone(&e.data));
    }

    guard.used_bytes = guard.used_bytes.saturating_add(loaded_bytes);
    guard.peak_used_bytes = guard.peak_used_bytes.max(guard.used_bytes);
    guard.map.insert(
        toml_path.to_string(),
        CachedCapture {
            data: Arc::clone(&loaded),
            bytes: loaded_bytes,
            last_used_tick: tick,
        },
    );

    while guard.used_bytes > guard.budget_bytes {
        let mut oldest_key: Option<String> = None;
        let mut oldest_tick = u64::MAX;
        for (k, v) in &guard.map {
            if v.last_used_tick < oldest_tick {
                oldest_tick = v.last_used_tick;
                oldest_key = Some(k.clone());
            }
        }
        let Some(k) = oldest_key else { break };
        if let Some(removed) = guard.map.remove(&k) {
            guard.used_bytes = guard.used_bytes.saturating_sub(removed.bytes);
        } else {
            break;
        }
    }

    Ok(loaded)
}
