use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

#[derive(Clone, Copy, Debug)]
struct V3(f32, f32, f32);

#[derive(Default)]
struct ObjData {
    vertices: Vec<V3>,
    triangles: Vec<[usize; 3]>,
}

fn parse_obj(path: &Path) -> Result<ObjData> {
    let text = fs::read_to_string(path).with_context(|| format!("read obj: {}", path.display()))?;
    let mut out = ObjData::default();
    for line_raw in text.lines() {
        let line = line_raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("v ") {
            let p: Vec<&str> = rest.split_whitespace().collect();
            if p.len() >= 3 {
                let x = p[0].parse::<f32>().unwrap_or(0.0);
                let y = p[1].parse::<f32>().unwrap_or(0.0);
                let z = p[2].parse::<f32>().unwrap_or(0.0);
                out.vertices.push(V3(x, y, z));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("f ") {
            let toks: Vec<&str> = rest.split_whitespace().collect();
            if toks.len() < 3 {
                continue;
            }
            let mut face = Vec::new();
            for t in toks {
                let idx_s = t.split('/').next().unwrap_or("");
                let idx = idx_s.parse::<isize>().unwrap_or(0);
                if idx == 0 {
                    continue;
                }
                let vcount = out.vertices.len() as isize;
                let zero = if idx > 0 { idx - 1 } else { vcount + idx };
                if zero >= 0 && zero < vcount {
                    face.push(zero as usize);
                }
            }
            if face.len() < 3 {
                continue;
            }
            for i in 1..(face.len() - 1) {
                out.triangles.push([face[0], face[i], face[i + 1]]);
            }
        }
    }
    Ok(out)
}

fn dedupe_vertices(obj: &ObjData) -> (Vec<V3>, Vec<[usize; 3]>) {
    let mut map: HashMap<(u32, u32, u32), usize> = HashMap::new();
    let mut dedup = Vec::new();
    let mut remap = vec![0usize; obj.vertices.len()];
    for (i, v) in obj.vertices.iter().enumerate() {
        let key = (v.0.to_bits(), v.1.to_bits(), v.2.to_bits());
        let idx = if let Some(&k) = map.get(&key) {
            k
        } else {
            let k = dedup.len();
            dedup.push(*v);
            map.insert(key, k);
            k
        };
        remap[i] = idx;
    }
    let tris = obj
        .triangles
        .iter()
        .map(|t| [remap[t[0]], remap[t[1]], remap[t[2]]])
        .filter(|t| t[0] != t[1] && t[1] != t[2] && t[0] != t[2])
        .collect::<Vec<_>>();
    (dedup, tris)
}

fn connected_components(triangles: &[[usize; 3]]) -> Vec<Vec<usize>> {
    let tri_count = triangles.len();
    let mut vert_to_tris: HashMap<usize, Vec<usize>> = HashMap::new();
    for (ti, tri) in triangles.iter().enumerate() {
        for &v in tri {
            vert_to_tris.entry(v).or_default().push(ti);
        }
    }
    let mut seen = vec![false; tri_count];
    let mut comps = Vec::new();
    for start in 0..tri_count {
        if seen[start] {
            continue;
        }
        let mut q = VecDeque::new();
        let mut comp = Vec::new();
        seen[start] = true;
        q.push_back(start);
        while let Some(ti) = q.pop_front() {
            comp.push(ti);
            for &v in &triangles[ti] {
                if let Some(ns) = vert_to_tris.get(&v) {
                    for &n in ns {
                        if !seen[n] {
                            seen[n] = true;
                            q.push_back(n);
                        }
                    }
                }
            }
        }
        comps.push(comp);
    }
    comps
}

fn write_split_obj(path: &Path, vertices: &[V3], triangles: &[[usize; 3]], comps: &[Vec<usize>]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create dir: {}", parent.display()))?;
    }
    let mut f = fs::File::create(path).with_context(|| format!("create split obj: {}", path.display()))?;
    let mut global_offset = 1usize;
    for (ci, comp) in comps.iter().enumerate() {
        writeln!(f, "o segment_{ci:04}")?;
        let mut used = HashSet::new();
        for &ti in comp {
            for &v in &triangles[ti] {
                used.insert(v);
            }
        }
        let mut used_list = used.into_iter().collect::<Vec<_>>();
        used_list.sort_unstable();
        let mut local_map: HashMap<usize, usize> = HashMap::new();
        for (li, &old) in used_list.iter().enumerate() {
            local_map.insert(old, li + global_offset);
            let v = vertices[old];
            writeln!(f, "v {} {} {}", v.0, v.1, v.2)?;
        }
        for &ti in comp {
            let tri = triangles[ti];
            let a = local_map[&tri[0]];
            let b = local_map[&tri[1]];
            let c = local_map[&tri[2]];
            writeln!(f, "f {a} {b} {c}")?;
        }
        global_offset += used_list.len();
    }
    Ok(())
}

fn process_file(src: &Path, dst: &Path) -> Result<()> {
    let obj = parse_obj(src)?;
    let (vertices, triangles) = dedupe_vertices(&obj);
    let comps = connected_components(&triangles);
    write_split_obj(dst, &vertices, &triangles, &comps)?;
    Ok(())
}

fn process_map_dir(map_dir: &Path) -> Result<()> {
    let src_root = map_dir.join("navmesh_objs");
    if !src_root.exists() {
        return Ok(());
    }
    let dst_root = map_dir.join("navmesh_objs_split");
    let mut stack = vec![src_root.clone()];
    while let Some(dir) = stack.pop() {
        let rd = fs::read_dir(&dir).with_context(|| format!("read dir: {}", dir.display()))?;
        for ent in rd {
            let ent = ent?;
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase() != "obj" {
                continue;
            }
            let rel = p.strip_prefix(&src_root).unwrap_or(&p);
            let dst = dst_root.join(rel);
            process_file(&p, &dst)?;
            println!("split: {}", rel.display());
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let cwd = std::env::current_dir().context("cwd")?;
    let planner_root = cwd.join("map-work").join("capture-planner");
    let maybe_map = std::env::args().nth(1);
    if let Some(map_id) = maybe_map {
        process_map_dir(&planner_root.join(map_id))?;
    } else {
        let rd = fs::read_dir(&planner_root).with_context(|| format!("read planner root: {}", planner_root.display()))?;
        for ent in rd {
            let ent = ent?;
            let p: PathBuf = ent.path();
            if !p.is_dir() {
                continue;
            }
            process_map_dir(&p)?;
        }
    }
    Ok(())
}
