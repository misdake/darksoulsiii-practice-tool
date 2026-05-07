use std::path::Path;

use anyhow::{Context, Result};
use exr::image::FlatSamples;
use exr::prelude::read_first_flat_layer_from_file;

pub fn read_depth_exr_first_channel(path: &Path) -> Result<(Vec<f32>, usize, usize)> {
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

pub fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub fn normalize3(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len <= 1.0e-8 {
        [0.0, 0.0, 0.0]
    } else {
        [v[0] / len, v[1] / len, v[2] / len]
    }
}

pub fn linearize_depth(depth01: f32, near: f32, far: f32) -> f32 {
    (near * far) / (far - depth01 * (far - near))
}

pub fn camera_to_world(
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
    [
        tx + right[0] * vx + up_ortho[0] * vy + dir[0] * vz,
        ty + right[1] * vx + up_ortho[1] * vy + dir[1] * vz,
        tz + right[2] * vx + up_ortho[2] * vy + dir[2] * vz,
    ]
}

pub struct CameraProjection {
    pub fov_y_rad: f32,
    pub near: f32,
    pub far: f32,
    pub camera_up: [f32; 3],
    pub camera_dir: [f32; 3],
    pub camera_position: [f32; 3],
}

pub struct ImageSize {
    pub width: usize,
    pub height: usize,
}

pub fn unproject_center_to_world(
    depth01: f32,
    image: ImageSize,
    proj: &CameraProjection,
) -> [f32; 3] {
    let z = linearize_depth(depth01, proj.near, proj.far);
    let aspect = image.width as f32 / image.height as f32;
    let tan_half_fovy = (proj.fov_y_rad * 0.5).tan();
    let tan_half_fovx = tan_half_fovy * aspect;
    let p_camera = [0.0 * tan_half_fovx, 0.0 * tan_half_fovy, z];
    camera_to_world(p_camera, proj.camera_up, proj.camera_dir, proj.camera_position)
}
