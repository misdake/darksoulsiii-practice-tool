use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};

use crate::geom::Vec3;
use crate::mesh::Mesh;

#[allow(dead_code)]
pub fn load_obj_mesh(path: &Path) -> Result<Mesh> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut vertices: Vec<Vec3> = Vec::new();
    let mut faces: Vec<[usize; 3]> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("v ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() < 3 {
                continue;
            }
            let x: f32 = parts[0].parse().context("parse obj vertex x")?;
            let y: f32 = parts[1].parse().context("parse obj vertex y")?;
            let z: f32 = parts[2].parse().context("parse obj vertex z")?;
            vertices.push([x, y, z]);
        } else if let Some(rest) = line.strip_prefix("f ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() < 3 {
                continue;
            }
            let mut idx = [0usize; 3];
            for i in 0..3 {
                let first = parts[i].split('/').next().unwrap_or_default();
                let parsed: usize = first.parse().context("parse obj face index")?;
                idx[i] = parsed - 1;
            }
            faces.push(idx);
        }
    }
    if vertices.is_empty() || faces.is_empty() {
        anyhow::bail!("OBJ has no vertices/faces: {}", path.display());
    }
    Ok(Mesh::from_vertices_indices(vertices, faces))
}

pub fn load_obj_meshes_from_dir(dir: &Path) -> Result<Mesh> {
    let mut obj_files = Vec::new();
    for entry in fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))? {
        let p = entry?.path();
        if p.extension().and_then(|s| s.to_str()) == Some("obj") {
            obj_files.push(p);
        }
    }
    obj_files.sort();
    if obj_files.is_empty() {
        anyhow::bail!("no obj files in {}", dir.display());
    }
    let mut vertices: Vec<Vec3> = Vec::new();
    let mut faces: Vec<[usize; 3]> = Vec::new();
    for obj in obj_files {
        let text = fs::read_to_string(&obj).with_context(|| format!("read {}", obj.display()))?;
        let base = vertices.len();
        let mut local_v = 0usize;
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("v ") {
                let parts: Vec<&str> = rest.split_whitespace().collect();
                if parts.len() < 3 {
                    continue;
                }
                let x: f32 = parts[0].parse().context("parse obj vertex x")?;
                let y: f32 = parts[1].parse().context("parse obj vertex y")?;
                let z: f32 = parts[2].parse().context("parse obj vertex z")?;
                vertices.push([x, y, z]);
                local_v += 1;
            }
        }
        if local_v == 0 {
            continue;
        }
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("f ") {
                let parts: Vec<&str> = rest.split_whitespace().collect();
                if parts.len() < 3 {
                    continue;
                }
                let mut idx = [0usize; 3];
                for i in 0..3 {
                    let first = parts[i].split('/').next().unwrap_or_default();
                    let parsed: usize = first.parse().context("parse obj face index")?;
                    idx[i] = base + parsed - 1;
                }
                faces.push(idx);
            }
        }
    }
    if vertices.is_empty() || faces.is_empty() {
        anyhow::bail!("no triangles parsed from {}", dir.display());
    }
    Ok(Mesh::from_vertices_indices(vertices, faces))
}

#[allow(dead_code)]
pub struct ToolchainConfig {
    pub map_dir: PathBuf,
    pub binder_tool: PathBuf,
    pub souls_collision_export: PathBuf,
}

#[allow(dead_code)]
pub fn load_mesh_from_hkxbdt_via_tools(cfg: &ToolchainConfig) -> Result<Mesh> {
    let bdt = cfg.map_dir.join("h40_00_00_00.hkxbdt");
    if !bdt.is_file() {
        anyhow::bail!("missing hkxbdt: {}", bdt.display());
    }
    let export_root = cfg.map_dir.join("collision_export_h40");
    let unpack_dir = export_root.join("binder_unpack");
    fs::create_dir_all(&unpack_dir).with_context(|| format!("mkdir {}", unpack_dir.display()))?;

    let binder = Command::new(&cfg.binder_tool)
        .arg(&bdt)
        .arg(&unpack_dir)
        .status()
        .with_context(|| format!("run {}", cfg.binder_tool.display()))?;
    if !binder.success() {
        anyhow::bail!("BinderTool failed with status {}", binder);
    }

    let hkx_dir = unpack_dir.join("m40_00_00_00");
    if !hkx_dir.is_dir() {
        anyhow::bail!("unexpected unpack layout: {}", hkx_dir.display());
    }

    let mut hkx_files = Vec::new();
    for entry in fs::read_dir(&hkx_dir).with_context(|| format!("read_dir {}", hkx_dir.display()))? {
        let p = entry?.path();
        if p.extension().and_then(|e| e.to_str()) == Some("hkx") {
            hkx_files.push(p);
        }
    }
    hkx_files.sort();
    if hkx_files.is_empty() {
        anyhow::bail!("no hkx files under {}", hkx_dir.display());
    }

    for hkx in &hkx_files {
        let obj = PathBuf::from(format!("{}.obj", hkx.display()));
        if obj.is_file() {
            continue;
        }
        let status = Command::new(&cfg.souls_collision_export)
            .arg(hkx)
            .status()
            .with_context(|| format!("run {}", cfg.souls_collision_export.display()))?;
        if !status.success() {
            eprintln!("warn: convert failed for {}", hkx.display());
        }
    }

    let mut vertices: Vec<Vec3> = Vec::new();
    let mut faces: Vec<[usize; 3]> = Vec::new();
    for hkx in &hkx_files {
        let obj = PathBuf::from(format!("{}.obj", hkx.display()));
        if !obj.is_file() {
            continue;
        }
        let text = fs::read_to_string(&obj).with_context(|| format!("read {}", obj.display()))?;
        let base = vertices.len();
        let mut local_v = 0usize;
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("v ") {
                let parts: Vec<&str> = rest.split_whitespace().collect();
                if parts.len() < 3 {
                    continue;
                }
                let x: f32 = parts[0].parse().context("parse obj vertex x")?;
                let y: f32 = parts[1].parse().context("parse obj vertex y")?;
                let z: f32 = parts[2].parse().context("parse obj vertex z")?;
                vertices.push([x, y, z]);
                local_v += 1;
            }
        }
        if local_v == 0 {
            continue;
        }
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("f ") {
                let parts: Vec<&str> = rest.split_whitespace().collect();
                if parts.len() < 3 {
                    continue;
                }
                let mut idx = [0usize; 3];
                for i in 0..3 {
                    let first = parts[i].split('/').next().unwrap_or_default();
                    let parsed: usize = first.parse().context("parse obj face index")?;
                    idx[i] = base + parsed - 1;
                }
                faces.push(idx);
            }
        }
    }
    if vertices.is_empty() || faces.is_empty() {
        anyhow::bail!("no triangles parsed from converted hkx objs");
    }
    Ok(Mesh::from_vertices_indices(vertices, faces))
}
