use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::mesh::Mesh;

#[derive(Serialize)]
pub struct OutputMeta {
    pub map_id: String,
    pub source_mesh: String,
    pub seed_game: [f32; 3],
    pub seed_internal: [f32; 3],
    pub grounded_point: [f32; 3],
    pub reached_triangles: usize,
    pub total_triangles: usize,
}

pub fn write_walkable_obj(mesh: &Mesh, reached: &[bool], path: &Path) -> Result<()> {
    let mut out = String::new();
    let mut remap: HashMap<usize, usize> = HashMap::new();
    let mut verts = Vec::new();
    for (ti, t) in mesh.tris.iter().enumerate() {
        if !reached[ti] {
            continue;
        }
        for &vi in &t.idx {
            remap.entry(vi).or_insert_with(|| {
                verts.push(mesh.vertices[vi]);
                verts.len()
            });
        }
    }
    for v in &verts {
        out.push_str(&format!("v {} {} {}\n", v[0], v[1], v[2]));
    }
    for (ti, t) in mesh.tris.iter().enumerate() {
        if !reached[ti] {
            continue;
        }
        let a = remap[&t.idx[0]];
        let b = remap[&t.idx[1]];
        let c = remap[&t.idx[2]];
        out.push_str(&format!("f {} {} {}\n", a, b, c));
    }
    fs::write(path, out).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

pub fn write_meta_json(meta: &OutputMeta, path: &Path) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(meta).context("serialize output meta")?;
    fs::write(path, bytes).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}
