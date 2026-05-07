use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use ds3_depthbuffer::{camera_to_world, linearize_depth, read_depth_exr_first_channel};

use crate::common::{
    CaptureData, CaptureToml, CloudPoint, SCALE_WORLD_UNITS_PER_PIXEL, TILE_SIZE_PX,
};
use crate::fs_utils::{encode_coord, file_stem_utf8, sanitize_filename};

pub fn split_capture_to_tile_points(toml_path: &Path, tile_points_root: &Path) -> Result<usize> {
    let capture = load_capture_from_toml(toml_path)?;
    let capture_stem = file_stem_utf8(toml_path)?;
    let capture_name = sanitize_filename(&capture_stem);

    let points = capture_to_points(&capture);
    let z_max = SCALE_WORLD_UNITS_PER_PIXEL.len() - 1;
    let tile_world_size = TILE_SIZE_PX as f32 * SCALE_WORLD_UNITS_PER_PIXEL[z_max];

    let mut by_tile: HashMap<(i32, i32), Vec<CloudPoint>> = HashMap::new();
    for p in points {
        let tx = (p.x / tile_world_size).floor() as i32;
        let ty = (p.z / tile_world_size).floor() as i32;
        by_tile.entry((tx, ty)).or_default().push(p);
    }

    let mut written = 0usize;
    for ((tx, ty), pts) in by_tile {
        let dir = tile_points_root.join(encode_coord(tx)).join(encode_coord(ty));
        fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
        let out = dir.join(format!("{}.ds3tile", capture_name));
        write_ds3tile(&out, &pts)?;
        written += pts.len();
    }

    Ok(written)
}

pub fn list_tile_point_dirs(tile_points_root: &Path) -> Result<Vec<(i32, i32, PathBuf)>> {
    let mut out = Vec::new();
    if !tile_points_root.exists() {
        return Ok(out);
    }

    for x_entry in fs::read_dir(tile_points_root)
        .with_context(|| format!("read_dir {}", tile_points_root.display()))?
    {
        let x_path = x_entry?.path();
        if !x_path.is_dir() {
            continue;
        }
        let x_name = x_path
            .file_name()
            .and_then(|s| s.to_str())
            .with_context(|| format!("invalid x dir {}", x_path.display()))?;
        let tx: i32 = x_name.parse().with_context(|| format!("invalid tile x '{}'", x_name))?;

        for y_entry in
            fs::read_dir(&x_path).with_context(|| format!("read_dir {}", x_path.display()))?
        {
            let y_path = y_entry?.path();
            if !y_path.is_dir() {
                continue;
            }
            let y_name = y_path
                .file_name()
                .and_then(|s| s.to_str())
                .with_context(|| format!("invalid y dir {}", y_path.display()))?;
            let ty: i32 = y_name.parse().with_context(|| format!("invalid tile y '{}'", y_name))?;
            out.push((tx, ty, y_path));
        }
    }

    out.sort_by_key(|(tx, ty, _)| (*tx, *ty));
    Ok(out)
}

pub fn read_ds3tile(path: &Path) -> Result<Vec<CloudPoint>> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;

    if bytes.len() < 24 {
        anyhow::bail!("{} too small for ds3tile header", path.display());
    }
    if &bytes[0..8] != b"DS3TL01\0" {
        anyhow::bail!("{} invalid ds3tile magic", path.display());
    }
    let version = le_u32(&bytes, 8)?;
    if version != 1 {
        anyhow::bail!("{} unsupported ds3tile version {}", path.display(), version);
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

fn write_ds3tile(path: &Path, points: &[CloudPoint]) -> Result<()> {
    let mut out = Vec::with_capacity(24 + points.len() * 24);
    out.extend_from_slice(b"DS3TL01\0");
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

fn capture_to_points(capture: &CaptureData) -> Vec<CloudPoint> {
    let w = capture.width;
    let h = capture.height;
    let aspect = w as f32 / h as f32;
    let tan_half_fovy = (capture.fov_y_rad * 0.5).tan();
    let tan_half_fovx = tan_half_fovy * aspect;

    let mut points: Vec<CloudPoint> = Vec::new();
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
            let [wx, wy, wz] = camera_to_world(
                [px, py, pz],
                capture.camera_up,
                capture.camera_dir,
                capture.camera_position,
            );
            // Normalize all derived outputs to a right-handed world: flip Z once at export.
            let wz = -wz;

            let rgb = capture.rgb.get_pixel(x as u32, y as u32).0;
            points.push(CloudPoint {
                x: wx,
                y: wy,
                z: wz,
                r: srgb_u8_to_linear_f32(rgb[0]),
                g: srgb_u8_to_linear_f32(rgb[1]),
                b: srgb_u8_to_linear_f32(rgb[2]),
            });
        }
    }

    points
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

fn srgb_u8_to_linear_f32(v: u8) -> f32 {
    let c = v as f32 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
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
