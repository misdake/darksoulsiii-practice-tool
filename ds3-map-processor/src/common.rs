use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const TILE_SIZE_PX: u32 = 512;
pub const SCALE_WORLD_UNITS_PER_PIXEL: [f32; 6] = [1.0, 0.5, 0.25, 0.125, 0.0625, 0.03125];
pub const HOLE_FILL_ITERS: usize = 3;
pub const HOLE_ALERT_RADIUS: i32 = 2;
pub const MAX_POINT_BYTES_IN_FLIGHT: usize = 8 * 1024 * 1024 * 1024; // 8GB

#[derive(Debug, Deserialize)]
pub struct CaptureToml {
    pub rgb_file: String,
    pub depth_file: String,
    pub camera_position: [f32; 3],
    pub camera_up: Option<[f32; 3]>,
    pub camera_dir: Option<[f32; 3]>,
    pub camera_fov: f32,
    pub camera_near: f32,
    pub camera_far: f32,
}

pub struct CaptureData {
    pub rgb: image::RgbImage,
    pub depth: Vec<f32>,
    pub width: usize,
    pub height: usize,
    pub fov_y_rad: f32,
    pub near: f32,
    pub far: f32,
    pub camera_position: [f32; 3],
    pub camera_up: [f32; 3],
    pub camera_dir: [f32; 3],
}

#[derive(Clone, Copy)]
pub struct CloudPoint {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

#[derive(Default, Serialize)]
pub struct TileIndex {
    pub tile_size_px: u32,
    pub scales_world_units_per_pixel: Vec<f32>,
    pub levels: BTreeMap<String, LevelIndex>,
}

#[derive(Default, Serialize)]
pub struct LevelIndex {
    pub tile_world_size: f32,
    pub x: BTreeMap<String, Vec<String>>,
}

pub struct TileRenderResult {
    pub image: image::RgbImage,
    pub coverage: f32,
    pub hole_pixels_after_fill: usize,
}
