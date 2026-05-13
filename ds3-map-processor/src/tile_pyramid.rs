use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use image::imageops::FilterType;
use image::{DynamicImage, RgbaImage};

use crate::common::{LevelIndex, TileIndex, SCALE_WORLD_UNITS_PER_PIXEL, TILE_SIZE_PX};
use crate::fs_utils::encode_coord;

pub fn add_tile_to_index(index: &mut TileIndex, z: usize, tx: i32, ty: i32) {
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

pub fn build_coarse_png_from_children(
    tiles_root: &Path,
    child_z: usize,
    z: usize,
    tx: i32,
    ty: i32,
    skip_if_all_black: bool,
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
    if skip_if_all_black && is_all_black_rgba(&out) {
        return Ok(false);
    }

    let out_dir = tiles_root.join(z.to_string()).join(encode_coord(tx));
    fs::create_dir_all(&out_dir).with_context(|| format!("mkdir {}", out_dir.display()))?;
    let path = out_dir.join(format!("{}.png", encode_coord(ty)));
    DynamicImage::ImageRgba8(out)
        .save(&path)
        .with_context(|| format!("save png {}", path.display()))?;
    Ok(true)
}

fn is_all_black_rgba(img: &RgbaImage) -> bool {
    img.pixels().all(|p| p.0[0] == 0 && p.0[1] == 0 && p.0[2] == 0)
}
