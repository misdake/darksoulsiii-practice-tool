use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use exr::image::FlatSamples;
use exr::prelude::read_first_flat_layer_from_file;

use crate::common::{CaptureData, CaptureToml};

pub use crate::common::POINT_STRIDE;

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

pub fn export_point_cloud_binary_v2(
    capture: &CaptureData,
    out_path: &Path,
    stride: usize,
) -> Result<()> {
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
    Ok(())
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
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}
