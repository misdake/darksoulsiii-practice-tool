use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::common::{BinCoord, CloudPoint, BIN_TILE_DIM, FINEST_TILE_WORLD_SIZE};
use crate::fs_utils::{encode_coord, file_stem_utf8, sanitize_filename};

pub fn split_pointclouds_into_bins(toml_paths: &[PathBuf], bins_root: &Path) -> Result<()> {
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
            let dir =
                bins_root.join(format!("bin_{}_{}", encode_coord(bin.bx), encode_coord(bin.by)));
            fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
            let out = dir.join(format!("{}.ds3bin", sanitize_filename(&capture_stem)));
            write_ds3bin(&out, &pts)?;
        }
    }

    Ok(())
}

pub fn read_ds3bin(path: &Path) -> Result<Vec<CloudPoint>> {
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).with_context(|| format!("read {}", path.display()))?;

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

fn read_ds3pcd_v2_points(path: &Path) -> Result<Vec<CloudPoint>> {
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).with_context(|| format!("read {}", path.display()))?;

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
