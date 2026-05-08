use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::{collections::HashMap, collections::HashSet, fs};

use anyhow::{Context, Result};
use image::imageops::FilterType;
use image::{DynamicImage, RgbaImage};
use serde::Serialize;
use crate::common::{
    CloudPoint, LevelIndex, TileIndex, TileRenderResult,
    MAX_POINT_BYTES_IN_FLIGHT, SCALE_WORLD_UNITS_PER_PIXEL, TILE_SIZE_PX,
};
use crate::fs_utils::encode_coord;
use crate::stage1_pointcloud::{
    iter_points_in_aabb_for_tile, parse_tile_key, read_tile_pixel_index,
};
use crate::task_budget::run_with_budget;
#[path = "stage2/cache.rs"]
mod cache;
#[path = "stage2/walkable.rs"]
mod walkable;
#[path = "stage2/profile.rs"]
mod profile;
#[path = "stage2/render.rs"]
mod render;
use cache::{get_or_load_capture, new_capture_lru, CaptureLru};
use profile::{
    add_prof_ns, print_stage2_profile_summary, reset_stage2_profile_counters, PROF_ACCUM_NS,
    PROF_GET_OR_LOAD_NS, PROF_ITER_POINTS_NS, PROF_JPEG_NS, PROF_MASK_NS, PROF_REF_COUNT,
    PROF_RENDER_NS, PROF_TILE_COUNT,
};
use walkable::{
    apply_walkable_mask, load_walkable_mask, rasterize_walkable_mask_tile,
    write_merged_walkable_file, TileWalkableMask, WalkableMask,
};
use render::{
    accumulate_points_for_tile, is_all_black, new_tile_render_accum, render_tile_from_accum,
    srgb_u8_to_linear_f32,
};

const STAGE2_IMAGE_EXT: &str = "png";

pub struct Stage2BudgetStats {
    pub point_inflight_peak_bytes: usize,
    pub capture_cache_peak_bytes: usize,
}

#[derive(Clone, Copy, Serialize)]
struct TileZRange {
    tx: i32,
    ty: i32,
    z_min: f32,
    z_max: f32,
}

#[derive(Serialize)]
struct FinestManifest {
    version: u32,
    image_ext: String,
    finest_z: usize,
    tiles: Vec<TileZRange>,
}

struct FinestRenderEnv<'a> {
    tiles_root: &'a Path,
    z_max: usize,
    mask: &'a WalkableMask,
    precomputed_mask: Option<&'a [bool]>,
    capture_cache: &'a Arc<Mutex<CaptureLru>>,
}

struct FinestTileOutput {
    tile: TileRenderResult,
    z_range: TileZRange,
}

pub fn render_tiles_to_pyramid(
    capture_dir: &Path,
    tile_pixel_index_path: &Path,
    tiles_root: &Path,
    alerts_path: &Path,
    index_path: &Path,
) -> Result<Stage2BudgetStats> {
    reset_stage2_profile_counters();
    let mask = load_walkable_mask(capture_dir)?;
    write_merged_walkable_file(tiles_root, &mask)?;
    let capture_cache = Arc::new(Mutex::new(new_capture_lru()));

    let mut alerts = String::from("z,tile_x,tile_y,hole_pixels_after_fill,coverage\n");
    let z_max = SCALE_WORLD_UNITS_PER_PIXEL.len() - 1;
    let mut tile_index = TileIndex {
        tile_size_px: TILE_SIZE_PX,
        image_ext: STAGE2_IMAGE_EXT.to_string(),
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
    let finest_units_per_px = SCALE_WORLD_UNITS_PER_PIXEL[z_max];
    let precompute_total = finest_tasks.len();
    println!("  precompute walkable masks for finest tiles: {} tile(s).", precompute_total);
    let precompute_done = Arc::new(AtomicUsize::new(0));
    let precompute_store: Arc<Mutex<TileWalkableMask>> =
        Arc::new(Mutex::new(HashMap::with_capacity(precompute_total)));
    let mask_for_precompute = mask.clone();
    let store_for_precompute = Arc::clone(&precompute_store);
    let done_for_precompute = Arc::clone(&precompute_done);
    let precompute_tasks: Vec<(i32, i32)> =
        finest_tasks.iter().map(|(tx, ty, _)| (*tx, *ty)).collect();
    let _precompute_peak = run_with_budget(
        precompute_tasks,
        |_| 1usize,
        MAX_POINT_BYTES_IN_FLIGHT,
        std::thread::available_parallelism().map_or(1usize, |n| n.get().max(1)),
        move |(tx, ty), _| {
            let bits =
                rasterize_walkable_mask_tile(&mask_for_precompute, tx, ty, finest_units_per_px);
            store_for_precompute.lock().expect("precompute_store poisoned").insert((tx, ty), bits);
            let done = done_for_precompute.fetch_add(1, Ordering::SeqCst) + 1;
            if done.is_multiple_of(8) || done == precompute_total {
                let pct = if precompute_total == 0 {
                    100.0
                } else {
                    (done as f32 / precompute_total as f32) * 100.0
                };
                println!("    precompute {}/{} ({:.1}%)", done, precompute_total, pct);
            }
            Ok(())
        },
    )?;
    let precomputed_masks = Arc::new(
        Arc::try_unwrap(precompute_store)
            .expect("precompute_store still referenced")
            .into_inner()
            .expect("precompute_store poisoned"),
    );

    let completed = Arc::new(AtomicUsize::new(0));
    let finest_hits: Arc<Mutex<Vec<(i32, i32)>>> = Arc::new(Mutex::new(Vec::new()));
    let alert_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let z_ranges: Arc<Mutex<Vec<TileZRange>>> = Arc::new(Mutex::new(Vec::new()));

    let finest_tiles_root = tiles_root.to_path_buf();
    let finest_hits_in_task = Arc::clone(&finest_hits);
    let alert_lines_in_task = Arc::clone(&alert_lines);
    let z_ranges_in_task = Arc::clone(&z_ranges);
    let mask_in_task = mask.clone();
    let masks_in_task = Arc::clone(&precomputed_masks);
    let cache_in_task = Arc::clone(&capture_cache);
    let finest_peak_inflight = run_with_budget(
        finest_tasks,
        |(_, _, refs)| estimate_tile_refs_bytes(refs),
        MAX_POINT_BYTES_IN_FLIGHT,
        std::thread::available_parallelism().map_or(1usize, |n| n.get().max(1)),
        move |(tx, ty, refs), reserved_bytes| {
            let output = render_one_finest_tile(
                &refs,
                tx,
                ty,
                FinestRenderEnv {
                    tiles_root: &finest_tiles_root,
                    z_max,
                    mask: &mask_in_task,
                    precomputed_mask: masks_in_task.get(&(tx, ty)).map(|v| v.as_slice()),
                    capture_cache: &cache_in_task,
                },
            )?;

            if let Some(out) = output {
                finest_hits_in_task.lock().expect("finest_hits poisoned").push((tx, ty));
                z_ranges_in_task.lock().expect("z_ranges poisoned").push(out.z_range);
                if out.tile.hole_pixels_after_fill > 0 {
                    alert_lines_in_task.lock().expect("alert_lines poisoned").push(format!(
                        "{},{},{},{},{}",
                        z_max, tx, ty, out.tile.hole_pixels_after_fill, out.tile.coverage
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
    let mut manifest_tiles = z_ranges.lock().expect("z_ranges poisoned").clone();
    manifest_tiles.sort_by_key(|t| (t.tx, t.ty));

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
        let built_coords: Arc<Mutex<Vec<(i32, i32)>>> = Arc::new(Mutex::new(Vec::new()));
        let level_tiles_root = tiles_root.to_path_buf();
        let level_peak = run_with_budget(
            coarse_vec,
            |_| 1,
            MAX_POINT_BYTES_IN_FLIGHT,
            std::thread::available_parallelism().map_or(1usize, |n| n.get().max(1)),
            {
                let built_coords = Arc::clone(&built_coords);
                move |(tx, ty), _| {
                    if build_coarse_tile_from_children(&level_tiles_root, child_z, z, tx, ty)? {
                        built_coords.lock().expect("built_coords poisoned").push((tx, ty));
                    }
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
    let manifest = FinestManifest {
        version: 1,
        image_ext: STAGE2_IMAGE_EXT.to_string(),
        finest_z: z_max,
        tiles: manifest_tiles,
    };
    let manifest_path = tiles_root.join("finest_manifest.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).context("serialize finest manifest")?,
    )
    .with_context(|| format!("write {}", manifest_path.display()))?;
    let json = serde_json::to_vec_pretty(&tile_index).context("serialize tile index")?;
    fs::write(index_path, json).with_context(|| format!("write {}", index_path.display()))?;
    print_stage2_profile_summary();
    let capture_peak = capture_cache.lock().expect("capture_cache poisoned").peak_used_bytes;
    Ok(Stage2BudgetStats {
        point_inflight_peak_bytes: stage2_point_peak,
        capture_cache_peak_bytes: capture_peak,
    })
}


fn render_one_finest_tile(
    refs: &[crate::common::TilePixelRef],
    tx: i32,
    ty: i32,
    env: FinestRenderEnv<'_>,
) -> Result<Option<FinestTileOutput>> {
    let FinestRenderEnv {
        tiles_root,
        z_max,
        mask,
        precomputed_mask,
        capture_cache,
    } = env;
    let units_per_px = SCALE_WORLD_UNITS_PER_PIXEL[z_max];
    let mut accum = new_tile_render_accum();
    let mut has_any_points = false;
    let mut z_min = f32::INFINITY;
    let mut z_max_world = f32::NEG_INFINITY;
    let tile_world_size = TILE_SIZE_PX as f32 * SCALE_WORLD_UNITS_PER_PIXEL[z_max];
    for r in refs {
        PROF_REF_COUNT.fetch_add(1, Ordering::Relaxed);
        let t_load = std::time::Instant::now();
        let capture = get_or_load_capture(capture_cache, &r.capture_toml)?;
        add_prof_ns(&PROF_GET_OR_LOAD_NS, t_load.elapsed().as_nanos());
        let mut capture_points = Vec::new();
        let t_iter = std::time::Instant::now();
        iter_points_in_aabb_for_tile(
            &capture,
            &r.aabb,
            tx,
            ty,
            tile_world_size,
            |wx, wy, wz, rgb| {
                capture_points.push(CloudPoint {
                    x: wx,
                    y: wy,
                    z: wz,
                    r: srgb_u8_to_linear_f32(rgb[0]),
                    g: srgb_u8_to_linear_f32(rgb[1]),
                    b: srgb_u8_to_linear_f32(rgb[2]),
                });
            },
        );
        add_prof_ns(&PROF_ITER_POINTS_NS, t_iter.elapsed().as_nanos());
        if !capture_points.is_empty() {
            has_any_points = true;
            for p in &capture_points {
                z_min = z_min.min(p.y);
                z_max_world = z_max_world.max(p.y);
            }
            let t_accum = std::time::Instant::now();
            accumulate_points_for_tile(&mut accum, capture_points.as_slice(), tx, ty, units_per_px);
            add_prof_ns(&PROF_ACCUM_NS, t_accum.elapsed().as_nanos());
        }
    }

    if !has_any_points {
        return Ok(None);
    }

    PROF_TILE_COUNT.fetch_add(1, Ordering::Relaxed);
    let t_render = std::time::Instant::now();
    let mut tile = render_tile_from_accum(accum);
    add_prof_ns(&PROF_RENDER_NS, t_render.elapsed().as_nanos());
    let t_mask = std::time::Instant::now();
    apply_walkable_mask(&mut tile.image, tx, ty, units_per_px, mask, precomputed_mask);
    add_prof_ns(&PROF_MASK_NS, t_mask.elapsed().as_nanos());
    if tile.coverage < 0.0001 || is_all_black(&tile.image) {
        return Ok(None);
    }

    let x_name = encode_coord(tx);
    let y_name = encode_coord(ty);
    let z_name = z_max.to_string();
    let z_dir = tiles_root.join(&z_name).join(&x_name);
    fs::create_dir_all(&z_dir).with_context(|| format!("mkdir {}", z_dir.display()))?;
    let tile_path = z_dir.join(format!("{}.png", y_name));
    let t_jpeg = std::time::Instant::now();
    tile.image
        .save(&tile_path)
        .with_context(|| format!("save png {}", tile_path.display()))?;
    add_prof_ns(&PROF_JPEG_NS, t_jpeg.elapsed().as_nanos());

    Ok(Some(FinestTileOutput {
        tile,
        z_range: TileZRange {
            tx,
            ty,
            z_min,
            z_max: z_max_world,
        },
    }))
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

    let mut canvas = RgbaImage::new(TILE_SIZE_PX * 2, TILE_SIZE_PX * 2);
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
            .to_rgba8();
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
    let path = out_dir.join(format!("{}.png", encode_coord(ty)));
    DynamicImage::ImageRgba8(out)
        .save(&path)
        .with_context(|| format!("save png {}", path.display()))?;
    Ok(true)
}

