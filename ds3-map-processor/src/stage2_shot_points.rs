use std::fs;
use std::path::Path;
use std::time::SystemTime;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::coord_space::CoordSpace;

#[derive(Serialize)]
struct Stage2ShotPoint {
    id: usize,
    x: f32,
    y: f32,
    z: f32,
}

#[derive(Serialize)]
struct Stage2ShotPointsFile {
    coord_space: String,
    version: u32,
    source: String,
    points: Vec<Stage2ShotPoint>,
}

pub fn write_shot_points_from_capture_tomls(
    capture_dir: &Path,
    stage2_group_root: &Path,
) -> Result<()> {
    let mut tomls = Vec::new();
    for e in
        fs::read_dir(capture_dir).with_context(|| format!("read_dir {}", capture_dir.display()))?
    {
        let e = e?;
        let p = e.path();
        if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("toml") {
            tomls.push(p);
        }
    }
    tomls.sort_by(|a, b| {
        let am = fs::metadata(a).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        let bm = fs::metadata(b).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        am.cmp(&bm)
    });

    let mut points = Vec::<Stage2ShotPoint>::new();
    for p in tomls {
        let content = match fs::read_to_string(&p) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let value: toml::Value = match toml::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(arr) = value.get("camera_position").and_then(|v| v.as_array()) else {
            continue;
        };
        if arr.len() != 3 {
            continue;
        }
        let Some(x) = arr[0].as_float() else { continue };
        let Some(y) = arr[1].as_float() else { continue };
        let Some(z) = arr[2].as_float() else { continue };
        let p3 = [x as f32, y as f32, -(z as f32)];
        let is_dup = points
            .last()
            .map(|q| {
                let dx = q.x - p3[0];
                let dy = q.y - p3[1];
                let dz = q.z - p3[2];
                dx * dx + dy * dy + dz * dz < 1.0e-6
            })
            .unwrap_or(false);
        if !is_dup {
            points.push(Stage2ShotPoint { id: points.len(), x: p3[0], y: p3[1], z: p3[2] });
        }
    }
    if points.is_empty() {
        return Ok(());
    }
    let out = Stage2ShotPointsFile {
        coord_space: CoordSpace::Processor.as_str().to_string(),
        version: 1,
        source: "stage2_capture_camera_positions".to_string(),
        points,
    };
    let dst = stage2_group_root.join("shot_points.json");
    let bytes = serde_json::to_vec_pretty(&out).context("serialize stage2 shot points")?;
    fs::write(&dst, bytes).with_context(|| format!("write {}", dst.display()))?;
    Ok(())
}
