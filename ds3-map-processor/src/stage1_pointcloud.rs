use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use ds3_depthbuffer::{camera_to_world, linearize_depth, read_depth_exr_first_channel};

use crate::common::{
    CaptureData, CaptureToml, PixelAabb, TilePixelIndex, TilePixelRef, SCALE_WORLD_UNITS_PER_PIXEL,
    TILE_SIZE_PX,
};

pub fn preprocess_capture_tile_spans(toml_path: &Path) -> Result<HashMap<(i32, i32), PixelAabb>> {
    let capture = load_capture_from_toml(toml_path)?;
    let z_max = SCALE_WORLD_UNITS_PER_PIXEL.len() - 1;
    let tile_world_size = TILE_SIZE_PX as f32 * SCALE_WORLD_UNITS_PER_PIXEL[z_max];

    let w = capture.width;
    let h = capture.height;
    let aspect = w as f32 / h as f32;
    let tan_half_fovy = (capture.fov_y_rad * 0.5).tan();
    let tan_half_fovx = tan_half_fovy * aspect;

    let mut by_tile: HashMap<(i32, i32), PixelAabb> = HashMap::new();

    for y in 0..h {
        for x in 0..w {
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
            let [wx, _wy, wz_raw] = camera_to_world(
                [px, py, pz],
                capture.camera_up,
                capture.camera_dir,
                capture.camera_position,
            );
            // Match processor right-handed convention.
            let wz = -wz_raw;

            let tx = (wx / tile_world_size).floor() as i32;
            let ty = (wz / tile_world_size).floor() as i32;
            let e = by_tile.entry((tx, ty)).or_insert(PixelAabb {
                x_min: x as u32,
                x_max: x as u32,
                y_min: y as u32,
                y_max: y as u32,
                pixel_count: 0,
            });
            let xu = x as u32;
            let yu = y as u32;
            if xu < e.x_min {
                e.x_min = xu;
            }
            if xu > e.x_max {
                e.x_max = xu;
            }
            if yu < e.y_min {
                e.y_min = yu;
            }
            if yu > e.y_max {
                e.y_max = yu;
            }
            e.pixel_count = e.pixel_count.saturating_add(1);
        }
    }

    Ok(by_tile)
}

pub fn write_tile_pixel_index(index: &TilePixelIndex, path: &Path) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(index).context("serialize tile pixel index")?;
    fs::write(path, bytes).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

pub fn read_tile_pixel_index(path: &Path) -> Result<TilePixelIndex> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let index: TilePixelIndex = serde_json::from_slice(&bytes).context("parse tile pixel index")?;
    Ok(index)
}

pub fn tile_key(tx: i32, ty: i32) -> String {
    format!("{},{}", tx, ty)
}

pub fn parse_tile_key(key: &str) -> Result<(i32, i32)> {
    let mut it = key.split(',');
    let tx = it
        .next()
        .context("missing tx")?
        .parse::<i32>()
        .with_context(|| format!("invalid tx in key '{}'", key))?;
    let ty = it
        .next()
        .context("missing ty")?
        .parse::<i32>()
        .with_context(|| format!("invalid ty in key '{}'", key))?;
    Ok((tx, ty))
}

pub fn load_capture_from_toml(toml_path: &Path) -> Result<CaptureData> {
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
        camera_position: meta.camera_position,
        camera_up,
        camera_dir,
    })
}

pub fn iter_points_in_aabb_for_tile<F>(
    capture: &CaptureData,
    aabb: &PixelAabb,
    tx: i32,
    ty: i32,
    tile_world_size: f32,
    mut f: F,
) where
    F: FnMut(f32, f32, f32, [u8; 3]),
{
    let w = capture.width;
    let h = capture.height;
    let aspect = w as f32 / h as f32;
    let tan_half_fovy = (capture.fov_y_rad * 0.5).tan();
    let tan_half_fovx = tan_half_fovy * aspect;

    let tile_min_x = tx as f32 * tile_world_size;
    let tile_min_z = ty as f32 * tile_world_size;
    let tile_max_x = tile_min_x + tile_world_size;
    let tile_max_z = tile_min_z + tile_world_size;

    for y in aabb.y_min as usize..=aabb.y_max as usize {
        for x in aabb.x_min as usize..=aabb.x_max as usize {
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
            let [wx, wy, wz_raw] = camera_to_world(
                [px, py, pz],
                capture.camera_up,
                capture.camera_dir,
                capture.camera_position,
            );
            let wz = -wz_raw;

            if wx < tile_min_x || wx >= tile_max_x || wz < tile_min_z || wz >= tile_max_z {
                continue;
            }

            let rgb = capture.rgb.get_pixel(x as u32, y as u32).0;
            f(wx, wy, wz, rgb);
        }
    }
}

pub fn make_tile_pixel_ref(capture_toml: &Path, aabb: PixelAabb) -> TilePixelRef {
    TilePixelRef { capture_toml: capture_toml.to_string_lossy().to_string(), aabb }
}
