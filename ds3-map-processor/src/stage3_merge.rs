use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result};
use image::imageops::FilterType;
use image::{DynamicImage, RgbaImage};
use serde::{Deserialize, Serialize};

use crate::common::{LevelIndex, TileIndex, SCALE_WORLD_UNITS_PER_PIXEL, TILE_SIZE_PX};
use crate::coord_space::{convert_z, parse_coord_space, CoordSpace};
use crate::fs_utils::encode_coord;
const MASK_EXPAND_WORLD: f32 = 2.0;

#[derive(Clone, Copy, Deserialize)]
struct TileZRange {
    tx: i32,
    ty: i32,
    z_min: f32,
    z_max: f32,
}

#[derive(Deserialize)]
struct FinestManifest {
    version: u32,
    image_ext: String,
    finest_z: usize,
    tiles: Vec<TileZRange>,
}

type Stage2TileSource = (PathBuf, String, TileZRange);

#[derive(Serialize)]
struct TileSourceList {
    version: u32,
    sources: Vec<TileSourceEntry>,
}

#[derive(Serialize)]
struct TileSourceEntry {
    name: String,
    path: String,
}

#[derive(Clone)]
struct TrajectoryMask {
    loops_xz: Vec<Vec<[f32; 2]>>,
    bounds: Vec<LoopBounds>,
}

#[derive(Clone, Copy)]
struct LoopBounds {
    min_x: f32,
    max_x: f32,
    min_z: f32,
    max_z: f32,
}

#[derive(Deserialize)]
struct TrajectorySimplifiedFile {
    #[serde(default)]
    coord_space: String,
    loops: Vec<Vec<[f32; 3]>>,
}

pub fn merge_stage2_outputs(inputs: &[PathBuf], output_root: &Path) -> Result<()> {
    println!("Stage 3/3 merge: {} input(s)", inputs.len());
    let mut per_tile: BTreeMap<(i32, i32), Vec<Stage2TileSource>> = BTreeMap::new();
    let mut finest_z = 0usize;

    for (i, root) in inputs.iter().enumerate() {
        let manifest_path = root.join("finest_manifest.json");
        let bytes = fs::read(&manifest_path).with_context(|| format!("read {}", manifest_path.display()))?;
        let manifest: FinestManifest =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", manifest_path.display()))?;
        let _ = manifest.version;
        let ext = manifest.image_ext.clone();
        finest_z = finest_z.max(manifest.finest_z);
        for t in manifest.tiles {
            per_tile.entry((t.tx, t.ty)).or_default().push((root.clone(), ext.clone(), t));
        }
        println!("  input {}/{}: {}", i + 1, inputs.len(), root.display());
    }
    let mask = load_stage2_trajectory_mask(inputs)?;

    let mut index = TileIndex {
        tile_size_px: TILE_SIZE_PX,
        image_ext: "png".to_string(),
        scales_world_units_per_pixel: SCALE_WORLD_UNITS_PER_PIXEL.to_vec(),
        levels: BTreeMap::new(),
    };

    let finest_total = per_tile.len();
    let finest_done = AtomicUsize::new(0);
    for (&(tx, ty), sources) in &per_tile {
        let mut sorted = sources.clone();
        sorted.sort_by(|a, b| {
            a.2.z_max
                .partial_cmp(&b.2.z_max)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.2.z_min.partial_cmp(&b.2.z_min).unwrap_or(std::cmp::Ordering::Equal))
        });

        let mut canvas = RgbaImage::new(TILE_SIZE_PX, TILE_SIZE_PX);
        for (root, ext, zr) in &sorted {
            let x_name = encode_coord(zr.tx);
            let y_name = encode_coord(zr.ty);
            let p = root.join(finest_z.to_string()).join(&x_name).join(format!("{}.{}", y_name, ext));
            if !p.is_file() {
                continue;
            }
            let layer = image::open(&p)
                .with_context(|| format!("open {}", p.display()))?
                .to_rgba8();
            alpha_over(&mut canvas, &layer);
        }
        apply_trajectory_mask(
            &mut canvas,
            tx,
            ty,
            SCALE_WORLD_UNITS_PER_PIXEL[finest_z],
            &mask,
        );
        if is_all_black_rgba(&canvas) {
            let done = finest_done.fetch_add(1, Ordering::Relaxed) + 1;
            if done.is_multiple_of(16) || done == finest_total {
                let pct = if finest_total == 0 { 100.0 } else { (done as f32 / finest_total as f32) * 100.0 };
                println!("  finest {}/{} ({:.1}%)", done, finest_total, pct);
            }
            continue;
        }

        let out_dir = output_root.join(finest_z.to_string()).join(encode_coord(tx));
        fs::create_dir_all(&out_dir).with_context(|| format!("mkdir {}", out_dir.display()))?;
        let out_path = out_dir.join(format!("{}.png", encode_coord(ty)));
        save_png_rgba(&canvas, &out_path)?;
        add_tile_to_index(&mut index, finest_z, tx, ty);
        let done = finest_done.fetch_add(1, Ordering::Relaxed) + 1;
        if done.is_multiple_of(16) || done == finest_total {
            let pct = if finest_total == 0 { 100.0 } else { (done as f32 / finest_total as f32) * 100.0 };
            println!("  finest {}/{} ({:.1}%)", done, finest_total, pct);
        }
    }

    for z in (0..finest_z).rev() {
        let child_z = z + 1;
        let child_key = child_z.to_string();
        let Some(child_level) = index.levels.get(&child_key) else { continue };
        let mut coarse_coords: BTreeSet<(i32, i32)> = BTreeSet::new();
        for (x_name, ys) in &child_level.x {
            let Ok(cx) = x_name.parse::<i32>() else { continue };
            for y_name in ys {
                let Ok(cy) = y_name.parse::<i32>() else { continue };
                coarse_coords.insert((cx.div_euclid(2), cy.div_euclid(2)));
            }
        }
        for (tx, ty) in coarse_coords {
            if build_coarse_png_from_children(output_root, child_z, z, tx, ty)? {
                add_tile_to_index(&mut index, z, tx, ty);
            }
        }
        println!("  pyramid z={} done (from z={})", z, child_z);
    }

    let json = serde_json::to_vec_pretty(&index).context("serialize stage3 index")?;
    fs::write(output_root.join("index.json"), json).context("write stage3 index")?;
    write_sources_list(inputs, output_root)?;
    Ok(())
}

fn load_stage2_trajectory_mask(inputs: &[PathBuf]) -> Result<TrajectoryMask> {
    let mut loops_xz: Vec<Vec<[f32; 2]>> = Vec::new();
    for root in inputs {
        let p = root.join("trajectory_simplified.json");
        if !p.is_file() {
            continue;
        }
        let bytes = fs::read(&p).with_context(|| format!("read {}", p.display()))?;
        let parsed: TrajectorySimplifiedFile =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", p.display()))?;
        let src_space = parse_coord_space(&parsed.coord_space);
        for lp in parsed.loops {
            if lp.len() < 3 {
                continue;
            }
            loops_xz.push(
                lp.into_iter()
                    .map(|v| [v[0], convert_z(v[2], src_space, CoordSpace::Processor)])
                    .collect(),
            );
        }
    }
    let mut bounds = Vec::with_capacity(loops_xz.len());
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
        bounds.push(LoopBounds { min_x, max_x, min_z, max_z });
    }
    Ok(TrajectoryMask { loops_xz, bounds })
}

fn apply_trajectory_mask(
    img: &mut RgbaImage,
    tx: i32,
    ty: i32,
    units_per_px: f32,
    mask: &TrajectoryMask,
) {
    if mask.loops_xz.is_empty() {
        return;
    }
    let tile_world_size = TILE_SIZE_PX as f32 * units_per_px;
    let min_x = tx as f32 * tile_world_size;
    let min_z = ty as f32 * tile_world_size;
    let max_x = min_x + tile_world_size;
    let max_z = min_z + tile_world_size;

    let mut candidates = Vec::new();
    for (i, b) in mask.bounds.iter().enumerate() {
        if b.max_x + MASK_EXPAND_WORLD < min_x
            || b.min_x - MASK_EXPAND_WORLD > max_x
            || b.max_z + MASK_EXPAND_WORLD < min_z
            || b.min_z - MASK_EXPAND_WORLD > max_z
        {
            continue;
        }
        candidates.push(i);
    }
    if candidates.is_empty() {
        for py in 0..TILE_SIZE_PX {
            for px in 0..TILE_SIZE_PX {
                img.put_pixel(px, py, image::Rgba([0, 0, 0, 0]));
            }
        }
        return;
    }

    for py in 0..TILE_SIZE_PX {
        for px in 0..TILE_SIZE_PX {
            let wx = min_x + (px as f32 + 0.5) * units_per_px;
            let wz = min_z + (py as f32 + 0.5) * units_per_px;
            if !point_in_or_near_loops(wx, wz, &mask.loops_xz, &mask.bounds, &candidates) {
                img.put_pixel(px, py, image::Rgba([0, 0, 0, 0]));
            }
        }
    }
}

fn point_in_or_near_loops(
    x: f32,
    z: f32,
    loops: &[Vec<[f32; 2]>],
    bounds: &[LoopBounds],
    candidates: &[usize],
) -> bool {
    let e2 = MASK_EXPAND_WORLD * MASK_EXPAND_WORLD;
    for &li in candidates {
        let b = bounds[li];
        if x < b.min_x - MASK_EXPAND_WORLD
            || x > b.max_x + MASK_EXPAND_WORLD
            || z < b.min_z - MASK_EXPAND_WORLD
            || z > b.max_z + MASK_EXPAND_WORLD
        {
            continue;
        }
        let lp = &loops[li];
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

fn write_sources_list(inputs: &[PathBuf], output_root: &Path) -> Result<()> {
    let map_work_root = output_root.parent().context("stage3 output root has no parent")?;
    let mut entries = Vec::with_capacity(inputs.len() + 1);
    entries.push(TileSourceEntry {
        name: "stage3 merged".to_string(),
        path: "./tiles".to_string(),
    });

    for root in inputs {
        let stage2_group_dir = root.parent().context("stage2 tiles root has no parent")?;
        let group_name = stage2_group_dir
            .file_name()
            .context("stage2 group dir has no name")?
            .to_string_lossy()
            .to_string();
        let rel = stage2_group_dir
            .strip_prefix(map_work_root)
            .with_context(|| format!("{} not under {}", stage2_group_dir.display(), map_work_root.display()))?;
        entries.push(TileSourceEntry {
            name: format!("stage2 {}", group_name),
            path: format!("./{}/tiles", rel.to_string_lossy().replace('\\', "/")),
        });
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    if let Some(i) = entries.iter().position(|e| e.path == "./tiles") {
        let merged = entries.remove(i);
        entries.insert(0, merged);
    }

    let list = TileSourceList { version: 1, sources: entries };
    let data = serde_json::to_vec_pretty(&list).context("serialize tile source list")?;
    fs::write(output_root.join("sources.json"), data).context("write tile source list")?;
    Ok(())
}

fn alpha_over(dst: &mut RgbaImage, src: &RgbaImage) {
    for (x, y, p) in src.enumerate_pixels() {
        let s = p.0;
        let sa = s[3] as f32 / 255.0;
        if sa <= 0.0 {
            continue;
        }
        let d = dst.get_pixel_mut(x, y);
        let da = d.0[3] as f32 / 255.0;
        let out_a = sa + da * (1.0 - sa);
        let mut out = [0u8; 4];
        if out_a > 0.0 {
            for c in 0..3 {
                let sc = s[c] as f32 / 255.0;
                let dc = d.0[c] as f32 / 255.0;
                let oc = (sc * sa + dc * da * (1.0 - sa)) / out_a;
                out[c] = (oc.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
            out[3] = (out_a.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        *d = image::Rgba(out);
    }
}

fn save_png_rgba(img: &RgbaImage, path: &Path) -> Result<()> {
    DynamicImage::ImageRgba8(img.clone())
        .save(path)
        .with_context(|| format!("save png {}", path.display()))?;
    Ok(())
}

fn is_all_black_rgba(img: &RgbaImage) -> bool {
    img.pixels().all(|p| p.0[0] == 0 && p.0[1] == 0 && p.0[2] == 0)
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

fn build_coarse_png_from_children(
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
    if is_all_black_rgba(&out) {
        return Ok(false);
    }

    let out_dir = tiles_root.join(z.to_string()).join(encode_coord(tx));
    fs::create_dir_all(&out_dir).with_context(|| format!("mkdir {}", out_dir.display()))?;
    let path = out_dir.join(format!("{}.png", encode_coord(ty)));
    save_png_rgba(&out, &path)?;
    Ok(true)
}
