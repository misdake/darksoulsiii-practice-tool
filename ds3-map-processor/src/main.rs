use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result};
use exr::image::FlatSamples;
use exr::prelude::read_first_flat_layer_from_file;
use image::{Rgb, RgbImage};
use serde::{Deserialize, Serialize};

const INPUT_CAPTURE_LIMIT: usize = 3;
const POINT_STRIDE: usize = 2;

const TILE_SIZE_PX: u32 = 256;
const FINEST_TILE_WORLD_SIZE: f32 = 64.0;
const BIN_TILE_DIM: i32 = 16;

const SCALE_WORLD_UNITS_PER_PIXEL: [f32; 5] = [1.0, 0.5, 0.25, 0.125, 0.0625];
const HOLE_FILL_ITERS: usize = 3;
const HOLE_ALERT_RADIUS: i32 = 2;

#[derive(Debug, Deserialize)]
struct CaptureToml {
    rgb_file: String,
    depth_file: String,
    player_position: Option<[f32; 3]>,
    camera_position: [f32; 3],
    camera_up: Option<[f32; 3]>,
    camera_dir: Option<[f32; 3]>,
    camera_fov: f32,
    camera_near: f32,
    camera_far: f32,
}

struct CaptureData {
    rgb: image::RgbImage,
    depth: Vec<f32>,
    width: usize,
    height: usize,
    fov_y_rad: f32,
    near: f32,
    far: f32,
    player_position: Option<[f32; 3]>,
    camera_position: [f32; 3],
    camera_up: [f32; 3],
    camera_dir: [f32; 3],
}

#[derive(Clone, Copy)]
struct CloudPoint {
    x: f32,
    y: f32,
    z: f32,
    r: f32,
    g: f32,
    b: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct BinCoord {
    bx: i32,
    by: i32,
}

#[derive(Default, Serialize)]
struct TileIndex {
    tile_size_px: u32,
    scales_world_units_per_pixel: Vec<f32>,
    levels: BTreeMap<String, LevelIndex>,
}

#[derive(Default, Serialize)]
struct LevelIndex {
    tile_world_size: f32,
    x: BTreeMap<String, Vec<String>>,
}

fn main() -> Result<()> {
    let repo_root = find_repo_root()?;
    let capture_dir = repo_root.join("capture");
    let work_dir = repo_root.join("map-work");
    ensure_workdir_layout(&work_dir)?;

    let toml_paths = find_all_toml_in_capture(&capture_dir)?;
    let selected: Vec<PathBuf> = toml_paths.into_iter().take(INPUT_CAPTURE_LIMIT).collect();
    println!(
        "Stage 1/3 capture->pointcloud: {} capture(s), stride={}.",
        selected.len(),
        POINT_STRIDE
    );

    for toml_path in &selected {
        let capture = load_capture_from_toml(toml_path)?;
        print_depth_diagnostics(&capture);

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

fn ensure_workdir_layout(work_dir: &Path) -> Result<()> {
    fs::create_dir_all(work_dir).with_context(|| format!("mkdir {}", work_dir.display()))?;
    let gitignore_path = work_dir.join(".gitignore");
    if !gitignore_path.exists() {
        let content = "# generated map workspace\n/bins/\n/tiles/\n/alerts.csv\n*.tmp\n";
        fs::write(&gitignore_path, content)
            .with_context(|| format!("write {}", gitignore_path.display()))?;
    }
    Ok(())
}

fn clear_directory(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).with_context(|| format!("read_dir {}", path.display()))? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            fs::remove_dir_all(&p).with_context(|| format!("remove_dir_all {}", p.display()))?;
        } else {
            fs::remove_file(&p).with_context(|| format!("remove_file {}", p.display()))?;
        }
    }
    Ok(())
}

fn split_pointclouds_into_bins(toml_paths: &[PathBuf], bins_root: &Path) -> Result<()> {
    let bin_world_size = FINEST_TILE_WORLD_SIZE * BIN_TILE_DIM as f32;

    for toml_path in toml_paths {
        let pcd_path = toml_path.with_extension("ds3pcd");
        let capture_stem = file_stem_utf8(toml_path)?;
        let points = read_ds3pcd_v2_points(&pcd_path)?;

        let mut by_bin: HashMap<BinCoord, Vec<CloudPoint>> = HashMap::new();
        for p in points {
            let bx = (p.x / bin_world_size).floor() as i32;
            let by = (p.z / bin_world_size).floor() as i32;
            by_bin.entry(BinCoord { bx, by }).or_default().push(p);
        }

        for (bin, pts) in by_bin {
            let dir = bins_root.join(format!("bin_{}_{}", encode_coord(bin.bx), encode_coord(bin.by)));
            fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
            let out = dir.join(format!("{}.ds3bin", sanitize_filename(&capture_stem)));
            write_ds3bin(&out, &pts)?;
        }
    }

    Ok(())
}

fn render_bins_to_tile_pyramid(
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
        levels: BTreeMap::new(),
    };

    // Phase A: render only the finest level directly from point cloud.
    for bin_dir in bins {
        let name = file_name_utf8(&bin_dir)?;
        let (bx, by) = parse_bin_dir_name(&name)?;

        let mut points: Vec<CloudPoint> = Vec::new();
        for entry in fs::read_dir(&bin_dir).with_context(|| format!("read_dir {}", bin_dir.display()))? {
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
                fs::create_dir_all(&z_dir)
                    .with_context(|| format!("mkdir {}", z_dir.display()))?;
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

    // Phase B: build coarser levels from finer level tiles (2x2 downsample).
    for z in (0..z_max).rev() {
        let child_z = z + 1;
        let child_key = child_z.to_string();
        let Some(child_level) = tile_index.levels.get(&child_key) else {
            continue;
        };

        let mut coarse_coords: Vec<(i32, i32)> = Vec::new();
        for (x_name, ys) in &child_level.x {
            let Some(cx) = decode_coord(x_name).ok() else {
                continue;
            };
            for y_name in ys {
                let Some(cy) = decode_coord(y_name).ok() else {
                    continue;
                };
                let tx = cx.div_euclid(2);
                let ty = cy.div_euclid(2);
                if !coarse_coords.iter().any(|(ax, ay)| *ax == tx && *ay == ty) {
                    coarse_coords.push((tx, ty));
                }
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
    let level = index.levels.entry(z_name).or_insert_with(|| LevelIndex {
        tile_world_size,
        x: BTreeMap::new(),
    });
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
    let child_coords = [
        (tx * 2, ty * 2),
        (tx * 2 + 1, ty * 2),
        (tx * 2, ty * 2 + 1),
        (tx * 2 + 1, ty * 2 + 1),
    ];

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
                let p = *child_img.get_pixel(x, y);
                canvas.put_pixel(ox + x, oy + y, p);
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

    let z_name = z.to_string();
    let x_name = encode_coord(tx);
    let y_name = encode_coord(ty);
    let out_dir = tiles_root.join(&z_name).join(&x_name);
    fs::create_dir_all(&out_dir).with_context(|| format!("mkdir {}", out_dir.display()))?;
    let out_path = out_dir.join(format!("{}.png", y_name));
    out.save(&out_path)
        .with_context(|| format!("save {}", out_path.display()))?;
    Ok(true)
}

struct TileRenderResult {
    image: RgbImage,
    coverage: f32,
    hole_pixels_after_fill: usize,
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
            } else {
                if has_neighbor_within(&has_core, x, y, HOLE_ALERT_RADIUS) {
                    holes_after_fill += 1;
                    out.put_pixel(x as u32, y as u32, Rgb([255, 0, 255]));
                } else {
                    out.put_pixel(x as u32, y as u32, Rgb([0, 0, 0]));
                }
            }
        }
    }

    TileRenderResult {
        image: out,
        coverage: covered as f32 / n as f32,
        hole_pixels_after_fill: holes_after_fill,
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

fn find_bin_dirs(bins_root: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(bins_root).with_context(|| format!("read_dir {}", bins_root.display()))? {
        let p = entry?.path();
        if p.is_dir() {
            out.push(p);
        }
    }
    out.sort();
    Ok(out)
}

fn parse_bin_dir_name(name: &str) -> Result<(i32, i32)> {
    let rest = name.strip_prefix("bin_").with_context(|| format!("invalid bin dir name: {}", name))?;
    let mut it = rest.split('_');
    let bx = decode_coord(it.next().context("missing bx")?)?;
    let by = decode_coord(it.next().context("missing by")?)?;
    Ok((bx, by))
}

fn write_ds3bin(path: &Path, points: &[CloudPoint]) -> Result<()> {
    let mut out = Vec::with_capacity(24 + points.len() * 24);
    out.extend_from_slice(b"DS3BIN1\0");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&(points.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for p in points {
        out.extend_from_slice(&p.x.to_le_bytes());
        out.extend_from_slice(&p.y.to_le_bytes());
        out.extend_from_slice(&p.z.to_le_bytes());
        out.extend_from_slice(&p.r.to_le_bytes());
        out.extend_from_slice(&p.g.to_le_bytes());
        out.extend_from_slice(&p.b.to_le_bytes());
    }
    fs::write(path, out).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

fn read_ds3bin(path: &Path) -> Result<Vec<CloudPoint>> {
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .with_context(|| format!("read {}", path.display()))?;

    if bytes.len() < 24 {
        anyhow::bail!("{} too small for ds3bin header", path.display());
    }
    if &bytes[0..8] != b"DS3BIN1\0" {
        anyhow::bail!("{} invalid ds3bin magic", path.display());
    }
    let version = le_u32(&bytes, 8)?;
    if version != 1 {
        anyhow::bail!("{} unsupported ds3bin version {}", path.display(), version);
    }
    let point_count = le_u32(&bytes, 12)? as usize;
    let payload = &bytes[24..];
    if payload.len() != point_count * 24 {
        anyhow::bail!(
            "{} payload mismatch, expected {} got {}",
            path.display(),
            point_count * 24,
            payload.len()
        );
    }

    let mut points = Vec::with_capacity(point_count);
    for i in 0..point_count {
        let o = i * 24;
        points.push(CloudPoint {
            x: le_f32(payload, o)?,
            y: le_f32(payload, o + 4)?,
            z: le_f32(payload, o + 8)?,
            r: le_f32(payload, o + 12)?,
            g: le_f32(payload, o + 16)?,
            b: le_f32(payload, o + 20)?,
        });
    }
    Ok(points)
}

fn read_ds3pcd_v2_points(path: &Path) -> Result<Vec<CloudPoint>> {
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .with_context(|| format!("read {}", path.display()))?;

    if bytes.len() < 32 {
        anyhow::bail!("{} too small for ds3pcd header", path.display());
    }
    if &bytes[0..8] != b"DS3PCD1\0" {
        anyhow::bail!("{} invalid ds3pcd magic", path.display());
    }
    let version = le_u32(&bytes, 8)?;
    if version != 2 {
        anyhow::bail!("{} unsupported ds3pcd version {}, expected v2", path.display(), version);
    }

    let point_count = le_u32(&bytes, 12)? as usize;
    let positions_offset = le_u32(&bytes, 16)? as usize;
    let colors_offset = le_u32(&bytes, 20)? as usize;

    let pos_bytes = point_count * 12;
    let color_bytes = point_count * 12;
    if positions_offset + pos_bytes > bytes.len() {
        anyhow::bail!("{} positions range out of bounds", path.display());
    }
    if colors_offset + color_bytes > bytes.len() {
        anyhow::bail!("{} colors range out of bounds", path.display());
    }

    let pos = &bytes[positions_offset..positions_offset + pos_bytes];
    let col = &bytes[colors_offset..colors_offset + color_bytes];

    let mut out = Vec::with_capacity(point_count);
    for i in 0..point_count {
        let o = i * 12;
        out.push(CloudPoint {
            x: le_f32(pos, o)?,
            y: le_f32(pos, o + 4)?,
            z: le_f32(pos, o + 8)?,
            r: le_f32(col, o)?,
            g: le_f32(col, o + 4)?,
            b: le_f32(col, o + 8)?,
        });
    }
    Ok(out)
}

fn le_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let arr: [u8; 4] = bytes
        .get(offset..offset + 4)
        .context("u32 out of bounds")?
        .try_into()
        .context("u32 slice length")?;
    Ok(u32::from_le_bytes(arr))
}

fn le_f32(bytes: &[u8], offset: usize) -> Result<f32> {
    let arr: [u8; 4] = bytes
        .get(offset..offset + 4)
        .context("f32 out of bounds")?
        .try_into()
        .context("f32 slice length")?;
    Ok(f32::from_le_bytes(arr))
}

fn export_point_cloud_binary_v2(capture: &CaptureData, out_path: &Path, stride: usize) -> Result<()> {
    let w = capture.width;
    let h = capture.height;
    let aspect = w as f32 / h as f32;
    let tan_half_fovy = (capture.fov_y_rad * 0.5).tan();
    let tan_half_fovx = tan_half_fovy * aspect;

    let mut positions: Vec<f32> = Vec::new();
    let mut colors: Vec<f32> = Vec::new();
    for y in (0..h).step_by(stride.max(1)) {
        for x in (0..w).step_by(stride.max(1)) {
            let idx = y * w + x;
            let depth_raw = capture.depth[idx];
            if !depth_raw.is_finite() {
                continue;
            }

            let depth01 = depth_raw.clamp(0.0, 1.0);
            let z = linearize_depth(depth01, capture.near, capture.far);
            if !(z > capture.near && z < capture.far) {
                continue;
            }

            let nx = ((x as f32 + 0.5) / w as f32) * 2.0 - 1.0;
            let ny = 1.0 - ((y as f32 + 0.5) / h as f32) * 2.0;
            let px = nx * tan_half_fovx * z;
            let py = ny * tan_half_fovy * z;
            let pz = z;
            let [wx, wy, wz] = camera_to_world(
                [px, py, pz],
                capture.camera_up,
                capture.camera_dir,
                capture.camera_position,
            );
            // Normalize all derived outputs to a right-handed world: flip Z once at export.
            let wz = -wz;

            let rgb = capture.rgb.get_pixel(x as u32, y as u32).0;
            positions.extend_from_slice(&[wx, wy, wz]);
            colors.extend_from_slice(&[
                srgb_u8_to_linear_f32(rgb[0]),
                srgb_u8_to_linear_f32(rgb[1]),
                srgb_u8_to_linear_f32(rgb[2]),
            ]);
        }
    }

    let point_count = (positions.len() / 3) as u32;
    let header_size = 32u32;
    let positions_offset = header_size;
    let colors_offset = positions_offset + point_count * 3 * std::mem::size_of::<f32>() as u32;

    let colors_bytes = point_count * 3 * std::mem::size_of::<f32>() as u32;
    let mut out = Vec::with_capacity((colors_offset + colors_bytes) as usize);
    out.extend_from_slice(b"DS3PCD1\0");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&point_count.to_le_bytes());
    out.extend_from_slice(&positions_offset.to_le_bytes());
    out.extend_from_slice(&colors_offset.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    for v in positions {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for c in colors {
        out.extend_from_slice(&c.to_le_bytes());
    }

    fs::write(out_path, out).with_context(|| format!("write {}", out_path.display()))?;
    if let Some([px, py, pz]) = capture.player_position {
        println!("  player position: [{px:.3}, {py:.3}, {pz:.3}]");
    }
    Ok(())
}

fn print_depth_diagnostics(capture: &CaptureData) {
    let mut values: Vec<f32> = capture.depth.iter().copied().filter(|v| v.is_finite()).collect();
    if values.is_empty() {
        println!("Depth diagnostics: no finite values.");
        return;
    }

    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = values.len();
    let p = |q: f32| -> f32 {
        let idx = ((n - 1) as f32 * q).round() as usize;
        values[idx]
    };

    let min = values[0];
    let max = values[n - 1];
    let p01 = p(0.01);
    let p50 = p(0.50);
    let p99 = p(0.99);

    let map_depth = |d: f32| linearize_depth(d, capture.near, capture.far);

    println!("Depth diagnostics:");
    println!("  raw min/max: {min:.6} .. {max:.6}");
    println!("  raw p01/p50/p99: {p01:.6} / {p50:.6} / {p99:.6}");
    println!("  mapped z(p50/p99): {:.3} / {:.3}", map_depth(p50), map_depth(p99));
}

fn find_repo_root() -> Result<PathBuf> {
    let mut dir = std::env::current_dir().context("get current_dir")?;
    loop {
        let cargo_toml = dir.join("Cargo.toml");
        let capture_dir = dir.join("capture");
        if cargo_toml.is_file() && capture_dir.is_dir() {
            return Ok(dir);
        }

        if !dir.pop() {
            break;
        }
    }

    anyhow::bail!("Cannot locate repo root (need both Cargo.toml and capture/).")
}

fn find_all_toml_in_capture(capture_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut all: Vec<PathBuf> = Vec::new();

    fn walk(dir: &Path, all: &mut Vec<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, all)?;
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("toml") {
                continue;
            }
            all.push(path);
        }
        Ok(())
    }

    walk(capture_dir, &mut all)?;
    if all.is_empty() {
        anyhow::bail!("No .toml files found under capture/.");
    }
    all.sort_by(|a, b| {
        let am = fs::metadata(a).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        let bm = fs::metadata(b).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        am.cmp(&bm)
    });
    Ok(all)
}

fn load_capture_from_toml(toml_path: &Path) -> Result<CaptureData> {
    let content =
        fs::read_to_string(toml_path).with_context(|| format!("read {}", toml_path.display()))?;
    let meta: CaptureToml = toml::from_str(&content).context("parse toml")?;
    let base_dir = toml_path.parent().context("toml has no parent directory")?;

    let rgb_path = base_dir.join(&meta.rgb_file);
    let depth_path = base_dir.join(&meta.depth_file);

    let rgb = image::open(&rgb_path)
        .with_context(|| format!("read rgb {}", rgb_path.display()))?
        .to_rgb8();
    let (rgb_w, rgb_h) = rgb.dimensions();

    let (depth, exr_w, exr_h) = read_depth_exr_first_channel(&depth_path)?;

    if rgb_w as usize != exr_w || rgb_h as usize != exr_h {
        anyhow::bail!("RGB/EXR size mismatch: rgb={}x{}, exr={}x{}", rgb_w, rgb_h, exr_w, exr_h);
    }

    let (camera_up, camera_dir) = if let (Some(up), Some(dir)) = (meta.camera_up, meta.camera_dir) {
        (up, dir)
    } else {
        anyhow::bail!("metadata missing camera orientation: need camera_up and camera_dir");
    };

    Ok(CaptureData {
        rgb,
        depth,
        width: exr_w,
        height: exr_h,
        fov_y_rad: meta.camera_fov,
        near: meta.camera_near,
        far: meta.camera_far,
        player_position: meta.player_position,
        camera_position: meta.camera_position,
        camera_up,
        camera_dir,
    })
}

fn read_depth_exr_first_channel(path: &Path) -> Result<(Vec<f32>, usize, usize)> {
    let image = read_first_flat_layer_from_file(path)
        .with_context(|| format!("read exr {}", path.display()))?;

    let w = image.layer_data.size.width();
    let h = image.layer_data.size.height();
    let channel = image.layer_data.channel_data.list.first().context("exr has no channels")?;

    let depth = match &channel.sample_data {
        FlatSamples::F16(values) => values.iter().map(|v| v.to_f32()).collect(),
        FlatSamples::F32(values) => values.clone(),
        FlatSamples::U32(values) => values.iter().map(|v| *v as f32).collect(),
    };

    Ok((depth, w, h))
}

fn camera_to_world(
    p_camera: [f32; 3],
    camera_up: [f32; 3],
    camera_dir: [f32; 3],
    camera_position: [f32; 3],
) -> [f32; 3] {
    let up = normalize3(camera_up);
    let dir = normalize3(camera_dir);
    let right = normalize3(cross(up, dir));
    let up_ortho = normalize3(cross(dir, right));

    let [vx, vy, vz] = p_camera;
    let [tx, ty, tz] = camera_position;

    let wx = tx + right[0] * vx + up_ortho[0] * vy + dir[0] * vz;
    let wy = ty + right[1] * vx + up_ortho[1] * vy + dir[1] * vz;
    let wz = tz + right[2] * vx + up_ortho[2] * vy + dir[2] * vz;
    [wx, wy, wz]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn normalize3(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len <= 1.0e-8 {
        [0.0, 0.0, 0.0]
    } else {
        [v[0] / len, v[1] / len, v[2] / len]
    }
}

fn linearize_depth(depth01: f32, near: f32, far: f32) -> f32 {
    (near * far) / (far - depth01 * (far - near))
}

fn srgb_u8_to_linear_f32(v: u8) -> f32 {
    let c = v as f32 / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn linear_f32_to_srgb_u8(v: f32) -> u8 {
    let s = if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    (s.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn file_stem_utf8(path: &Path) -> Result<String> {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .with_context(|| format!("invalid file stem: {}", path.display()))?;
    Ok(stem.to_string())
}

fn file_name_utf8(path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .with_context(|| format!("invalid file name: {}", path.display()))?;
    Ok(name.to_string())
}

fn sanitize_filename(input: &str) -> String {
    input
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

fn encode_coord(v: i32) -> String {
    if v < 0 {
        format!("n{}", v.unsigned_abs())
    } else {
        format!("p{}", v)
    }
}

fn decode_coord(s: &str) -> Result<i32> {
    if s.len() < 2 {
        anyhow::bail!("invalid coord '{}'", s);
    }
    let (sign, digits) = s.split_at(1);
    let mag: i32 = digits.parse().with_context(|| format!("invalid coord magnitude: {}", s))?;
    match sign {
        "n" => Ok(-mag),
        "p" => Ok(mag),
        _ => anyhow::bail!("invalid coord sign '{}'", sign),
    }
}
