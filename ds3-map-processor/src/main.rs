use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result};
use exr::image::FlatSamples;
use exr::prelude::read_first_flat_layer_from_file;
use serde::Deserialize;

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

fn main() -> Result<()> {
    let repo_root = find_repo_root()?;
    let capture_dir = repo_root.join("capture");
    let toml_paths = find_all_toml_in_capture(&capture_dir)?;
    println!("Found {} toml files under {}", toml_paths.len(), capture_dir.display());

    for toml_path in toml_paths {
        let capture = load_capture_from_toml(&toml_path)?;
        print_depth_diagnostics(&capture);

        let out_path = toml_path.with_extension("ply");
        export_point_cloud_ply(&capture, &out_path, 2)?;
        println!("Wrote point cloud: {}", out_path.display());
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

fn export_point_cloud_ply(capture: &CaptureData, out_path: &Path, stride: usize) -> Result<()> {
    let w = capture.width;
    let h = capture.height;
    let aspect = w as f32 / h as f32;
    let tan_half_fovy = (capture.fov_y_rad * 0.5).tan();
    let tan_half_fovx = tan_half_fovy * aspect;

    let mut points: Vec<(f32, f32, f32, u8, u8, u8)> = Vec::new();
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

            let rgb = capture.rgb.get_pixel(x as u32, y as u32).0;
            points.push((wx, wy, wz, rgb[0], rgb[1], rgb[2]));
        }
    }

    let mut ply = String::new();
    ply.push_str("ply\n");
    ply.push_str("format ascii 1.0\n");
    ply.push_str(&format!("element vertex {}\n", points.len()));
    ply.push_str("property float x\n");
    ply.push_str("property float y\n");
    ply.push_str("property float z\n");
    ply.push_str("property uchar red\n");
    ply.push_str("property uchar green\n");
    ply.push_str("property uchar blue\n");
    ply.push_str("end_header\n");
    for (x, y, z, r, g, b) in points {
        ply.push_str(&format!("{x} {y} {z} {r} {g} {b}\n"));
    }

    fs::write(out_path, ply).with_context(|| format!("write {}", out_path.display()))?;
    if let Some([px, py, pz]) = capture.player_position {
        println!("Player position (metadata): [{px:.3}, {py:.3}, {pz:.3}]");
    }
    Ok(())
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

    let [vx, vy, vz] = p_camera; // camera space: +x right, +y up, +z forward(dir)
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
