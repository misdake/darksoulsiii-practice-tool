use std::collections::HashMap;

use crate::geom::{centroid, cross, normalize, v_sub, Vec3};

#[derive(Clone, Debug)]
pub struct Tri {
    pub idx: [usize; 3],
    pub normal: Vec3,
    pub center: Vec3,
    pub min: Vec3,
    pub max: Vec3,
}

#[derive(Clone, Debug)]
pub struct Mesh {
    pub vertices: Vec<Vec3>,
    pub tris: Vec<Tri>,
    pub adjacency: Vec<Vec<usize>>,
}

impl Mesh {
    pub fn from_vertices_indices(vertices: Vec<Vec3>, faces: Vec<[usize; 3]>) -> Self {
        let mut tris = Vec::new();
        for idx in faces {
            let a = vertices[idx[0]];
            let b = vertices[idx[1]];
            let c = vertices[idx[2]];
            let n = normalize(cross(v_sub(b, a), v_sub(c, a)));
            let area2 = cross(v_sub(b, a), v_sub(c, a));
            if area2[0].abs() + area2[1].abs() + area2[2].abs() < 1e-7 {
                continue;
            }
            let min =
                [a[0].min(b[0]).min(c[0]), a[1].min(b[1]).min(c[1]), a[2].min(b[2]).min(c[2])];
            let max =
                [a[0].max(b[0]).max(c[0]), a[1].max(b[1]).max(c[1]), a[2].max(b[2]).max(c[2])];
            tris.push(Tri { idx, normal: n, center: centroid(a, b, c), min, max });
        }
        let adjacency = build_adjacency(&vertices, &tris);
        Self { vertices, tris, adjacency }
    }
}

fn qv(v: Vec3) -> (i32, i32, i32) {
    let s = 10000.0f32;
    ((v[0] * s).round() as i32, (v[1] * s).round() as i32, (v[2] * s).round() as i32)
}

fn qedge(a: Vec3, b: Vec3) -> ((i32, i32, i32), (i32, i32, i32)) {
    let qa = qv(a);
    let qb = qv(b);
    if qa <= qb {
        (qa, qb)
    } else {
        (qb, qa)
    }
}

fn build_adjacency(vertices: &[Vec3], tris: &[Tri]) -> Vec<Vec<usize>> {
    type QuantizedEdge = ((i32, i32, i32), (i32, i32, i32));
    let mut edge_to_tris: HashMap<QuantizedEdge, Vec<usize>> = HashMap::new();
    for (ti, t) in tris.iter().enumerate() {
        let vs = [vertices[t.idx[0]], vertices[t.idx[1]], vertices[t.idx[2]]];
        let edges = [qedge(vs[0], vs[1]), qedge(vs[1], vs[2]), qedge(vs[2], vs[0])];
        for e in edges {
            edge_to_tris.entry(e).or_default().push(ti);
        }
    }
    let mut adj = vec![Vec::new(); tris.len()];
    for group in edge_to_tris.values() {
        for i in 0..group.len() {
            for j in (i + 1)..group.len() {
                let a = group[i];
                let b = group[j];
                adj[a].push(b);
                adj[b].push(a);
            }
        }
    }
    for v in &mut adj {
        v.sort_unstable();
        v.dedup();
    }
    adj
}
