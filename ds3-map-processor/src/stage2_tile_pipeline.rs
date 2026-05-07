use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::{collections::HashSet, fs, thread};

use anyhow::{Context, Result};
use image::{Rgb, RgbImage};

use crate::common::{
    CloudPoint, LevelIndex, TileIndex, TileRenderResult, HOLE_ALERT_RADIUS, HOLE_FILL_ITERS,
    MAX_POINT_BYTES_IN_FLIGHT, SCALE_WORLD_UNITS_PER_PIXEL, TILE_SIZE_PX,
};
use crate::fs_utils::encode_coord;
use crate::stage1_pointcloud::{list_tile_point_dirs, read_ds3tile};

pub fn render_tiles_to_pyramid(
    tile_points_root: &Path,
    tiles_root: &Path,
    alerts_path: &Path,
    index_path: &Path,
) -> Result<()> {
    let mut alerts = String::from("z,tile_x,tile_y,hole_pixels_after_fill,coverage\n");
    let z_max = SCALE_WORLD_UNITS_PER_PIXEL.len() - 1;
    let mut tile_index = TileIndex {
        tile_size_px: TILE_SIZE_PX,
        scales_world_units_per_pixel: SCALE_WORLD_UNITS_PER_PIXEL.to_vec(),
        levels: std::collections::BTreeMap::new(),
    };

    let tile_dirs = list_tile_point_dirs(tile_points_root)?;
    let total_tiles = tile_dirs.len();
    println!("Stage 2/2 finest render: {} tile(s).", total_tiles);

    let start = Instant::now();
    let completed = Arc::new(AtomicUsize::new(0));
    let finest_hits: Arc<Mutex<Vec<(i32, i32)>>> = Arc::new(Mutex::new(Vec::new()));
    let alert_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let finest_tiles_root = tiles_root.to_path_buf();
    let finest_hits_in_task = Arc::clone(&finest_hits);
    let alert_lines_in_task = Arc::clone(&alert_lines);
    run_with_budget(
        tile_dirs,
        |(_, _, dir)| estimate_tile_dir_bytes(dir).unwrap_or(1),
        move |(tx, ty, dir), reserved_bytes| {
            let output = render_one_finest_tile(&dir, &finest_tiles_root, z_max, tx, ty)?;

            // After a successful render attempt (including low-coverage skip), remove consumed point shards.
            delete_tile_point_files(&dir)?;

            if let Some(tile) = output {
                finest_hits_in_task
                    .lock()
                    .expect("finest_hits poisoned")
                    .push((tx, ty));
                if tile.hole_pixels_after_fill > 0 {
                    alert_lines_in_task.lock().expect("alert_lines poisoned").push(format!(
                        "{},{},{},{},{}",
                        z_max, tx, ty, tile.hole_pixels_after_fill, tile.coverage
                    ));
                }
            }

            let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
            let elapsed = start.elapsed().as_secs_f32();
            let pct =
                if total_tiles == 0 { 100.0 } else { (done as f32 / total_tiles as f32) * 100.0 };
            let avg_ms = if done == 0 { 0.0 } else { elapsed * 1000.0 / done as f32 };
            println!(
                "  finest {}/{} ({:.1}%) avg={:.1}ms in_flight={}MB",
                done,
                total_tiles,
                pct,
                avg_ms,
                reserved_bytes / (1024 * 1024)
            );
            Ok(())
        },
    )?;

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
        let level_start = Instant::now();

        let level_tiles_root = tiles_root.to_path_buf();
        run_with_budget(coarse_vec, |_| 1, {
            let built_coords = Arc::clone(&built_coords);
            let level_done = Arc::clone(&level_done);
            move |(tx, ty), _| {
                if build_coarse_tile_from_children(&level_tiles_root, child_z, z, tx, ty)? {
                    built_coords.lock().expect("built_coords poisoned").push((tx, ty));
                }

                let done = level_done.fetch_add(1, Ordering::SeqCst) + 1;
                let elapsed = level_start.elapsed().as_secs_f32();
                let pct = if total == 0 { 100.0 } else { (done as f32 / total as f32) * 100.0 };
                let avg_ms = if done == 0 { 0.0 } else { elapsed * 1000.0 / done as f32 };
                println!("    z={} {}/{} ({:.1}%) avg={:.1}ms", z, done, total, pct, avg_ms);
                Ok(())
            }
        })?;

        for (tx, ty) in built_coords.lock().expect("built_coords poisoned").iter().copied() {
            add_tile_to_index(&mut tile_index, z, tx, ty);
        }
    }

    fs::write(alerts_path, alerts).with_context(|| format!("write {}", alerts_path.display()))?;
    let json = serde_json::to_vec_pretty(&tile_index).context("serialize tile index")?;
    fs::write(index_path, json).with_context(|| format!("write {}", index_path.display()))?;
    Ok(())
}

fn render_one_finest_tile(
    tile_dir: &Path,
    tiles_root: &Path,
    z_max: usize,
    tx: i32,
    ty: i32,
) -> Result<Option<TileRenderResult>> {
    let mut points = Vec::new();
    for entry in
        fs::read_dir(tile_dir).with_context(|| format!("read_dir {}", tile_dir.display()))?
    {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ds3tile") {
            continue;
        }
        points.extend(read_ds3tile(&path)?);
    }

    if points.is_empty() {
        return Ok(None);
    }

    let units_per_px = SCALE_WORLD_UNITS_PER_PIXEL[z_max];
    let tile = render_tile(points.as_slice(), tx, ty, units_per_px);
    if tile.coverage < 0.0001 {
        return Ok(None);
    }

    let x_name = encode_coord(tx);
    let y_name = encode_coord(ty);
    let z_name = z_max.to_string();
    let z_dir = tiles_root.join(&z_name).join(&x_name);
    fs::create_dir_all(&z_dir).with_context(|| format!("mkdir {}", z_dir.display()))?;
    let tile_path = z_dir.join(format!("{}.png", y_name));
    tile.image.save(&tile_path).with_context(|| format!("save {}", tile_path.display()))?;

    Ok(Some(tile))
}

fn delete_tile_point_files(tile_dir: &Path) -> Result<()> {
    for entry in
        fs::read_dir(tile_dir).with_context(|| format!("read_dir {}", tile_dir.display()))?
    {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("ds3tile") {
            fs::remove_file(&path).with_context(|| format!("remove_file {}", path.display()))?;
        }
    }

    let mut is_empty = true;
    if let Some(entry) = fs::read_dir(tile_dir)
        .with_context(|| format!("read_dir {}", tile_dir.display()))?
        .next()
    {
        let _ = entry?;
        is_empty = false;
    }
    if is_empty {
        fs::remove_dir(tile_dir).with_context(|| format!("remove_dir {}", tile_dir.display()))?;
    }

    if let Some(parent) = tile_dir.parent() {
        let mut parent_empty = true;
        if let Some(entry) = fs::read_dir(parent)
            .with_context(|| format!("read_dir {}", parent.display()))?
            .next()
        {
            let _ = entry?;
            parent_empty = false;
        }
        if parent_empty {
            let _ = fs::remove_dir(parent);
        }
    }

    Ok(())
}

fn estimate_tile_dir_bytes(tile_dir: &Path) -> Result<usize> {
    let mut sum = 0usize;
    for entry in
        fs::read_dir(tile_dir).with_context(|| format!("read_dir {}", tile_dir.display()))?
    {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ds3tile") {
            continue;
        }
        let len = fs::metadata(&path).with_context(|| format!("metadata {}", path.display()))?.len()
            as usize;
        sum = sum.saturating_add(len);
    }
    Ok(sum.max(1))
}

fn run_with_budget<T, FEst, FJob>(tasks: Vec<T>, estimate: FEst, job: FJob) -> Result<()>
where
    T: Send + Sync + Clone + 'static,
    FEst: Fn(&T) -> usize + Send + Sync + 'static,
    FJob: Fn(T, usize) -> Result<()> + Send + Sync + 'static,
{
    let max_workers = std::thread::available_parallelism().map_or(1usize, |n| n.get().max(1));
    let budget = MAX_POINT_BYTES_IN_FLIGHT;

    let tasks = Arc::new(tasks);
    let estimate = Arc::new(estimate);
    let job = Arc::new(job);

    let next = Arc::new(AtomicUsize::new(0));
    let inflight = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let first_err: Arc<Mutex<Option<anyhow::Error>>> = Arc::new(Mutex::new(None));

    let mut handles = Vec::with_capacity(max_workers);
    for _ in 0..max_workers {
        let tasks = Arc::clone(&tasks);
        let estimate = Arc::clone(&estimate);
        let job = Arc::clone(&job);
        let next = Arc::clone(&next);
        let inflight = Arc::clone(&inflight);
        let failed = Arc::clone(&failed);
        let first_err = Arc::clone(&first_err);

        handles.push(thread::spawn(move || loop {
            if failed.load(Ordering::SeqCst) {
                break;
            }

            let idx = next.fetch_add(1, Ordering::SeqCst);
            if idx >= tasks.len() {
                break;
            }
            let task = tasks[idx].clone();
            let est = estimate(&task).max(1);
            let reserve = est.min(budget.max(1));

            loop {
                if failed.load(Ordering::SeqCst) {
                    return;
                }
                let cur = inflight.load(Ordering::SeqCst);
                if (cur == 0 || cur.saturating_add(reserve) <= budget)
                    && inflight
                        .compare_exchange(
                            cur,
                            cur.saturating_add(reserve),
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        )
                        .is_ok()
                {
                    break;
                }
                thread::sleep(std::time::Duration::from_millis(2));
            }

            let result = job(task, inflight.load(Ordering::SeqCst));
            inflight.fetch_sub(reserve, Ordering::SeqCst);

            if let Err(err) = result {
                failed.store(true, Ordering::SeqCst);
                let mut slot = first_err.lock().expect("first_err poisoned");
                if slot.is_none() {
                    *slot = Some(err);
                }
                return;
            }
        }));
    }

    for handle in handles {
        let _ = handle.join();
    }

    if let Some(err) = first_err.lock().expect("first_err poisoned").take() {
        return Err(err);
    }

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
