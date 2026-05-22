use crate::geom::{cross, dot, v_sub, Vec3};
use crate::mesh::Mesh;

#[derive(Clone, Debug)]
pub struct RayHit {
    pub tri_index: usize,
    pub point: Vec3,
    pub t: f32,
}

#[derive(Clone, Debug)]
enum Node {
    Leaf { min: Vec3, max: Vec3, tris: Vec<usize> },
    Inner { min: Vec3, max: Vec3, left: Box<Node>, right: Box<Node> },
}

#[derive(Clone, Debug)]
pub struct Bvh {
    root: Node,
}

impl Bvh {
    pub fn build(mesh: &Mesh) -> Self {
        let all: Vec<usize> = (0..mesh.tris.len()).collect();
        Self { root: build_node(mesh, &all, 0) }
    }

    pub fn raycast_down(&self, mesh: &Mesh, origin: Vec3, max_dist: f32) -> Option<RayHit> {
        let mut best: Option<RayHit> = None;
        let dir = [0.0, -1.0, 0.0];
        raycast_node(&self.root, mesh, origin, dir, max_dist, &mut best);
        best
    }

    pub fn raycast_down_walkable(
        &self,
        mesh: &Mesh,
        origin: Vec3,
        max_dist: f32,
        min_normal_y_abs: f32,
    ) -> Option<RayHit> {
        let _ = self;
        let dir = [0.0, -1.0, 0.0];
        let mut best: Option<RayHit> = None;
        for (ti, t) in mesh.tris.iter().enumerate() {
            if t.normal[1].abs() < min_normal_y_abs {
                continue;
            }
            let v0 = mesh.vertices[t.idx[0]];
            let v1 = mesh.vertices[t.idx[1]];
            let v2 = mesh.vertices[t.idx[2]];
            if let Some(hit_t) = ray_tri_intersect(origin, dir, v0, v1, v2) {
                if hit_t < 0.0 || hit_t > max_dist {
                    continue;
                }
                match &best {
                    Some(cur) if cur.t <= hit_t => {},
                    _ => {
                        best = Some(RayHit {
                            tri_index: ti,
                            point: [origin[0], origin[1] - hit_t, origin[2]],
                            t: hit_t,
                        });
                    },
                }
            }
        }
        best
    }
}

fn build_node(mesh: &Mesh, tri_ids: &[usize], depth: usize) -> Node {
    let (min, max) = bounds_of(mesh, tri_ids);
    if tri_ids.len() <= 16 || depth >= 24 {
        return Node::Leaf { min, max, tris: tri_ids.to_vec() };
    }
    let extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let axis = if extent[0] >= extent[1] && extent[0] >= extent[2] {
        0
    } else if extent[1] >= extent[2] {
        1
    } else {
        2
    };
    let mut sorted = tri_ids.to_vec();
    sorted.sort_by(|&a, &b| {
        mesh.tris[a].center[axis].partial_cmp(&mesh.tris[b].center[axis]).unwrap()
    });
    let mid = sorted.len() / 2;
    if mid == 0 || mid == sorted.len() {
        return Node::Leaf { min, max, tris: sorted };
    }
    let left = build_node(mesh, &sorted[..mid], depth + 1);
    let right = build_node(mesh, &sorted[mid..], depth + 1);
    Node::Inner { min, max, left: Box::new(left), right: Box::new(right) }
}

fn bounds_of(mesh: &Mesh, tri_ids: &[usize]) -> (Vec3, Vec3) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for &ti in tri_ids {
        let t = &mesh.tris[ti];
        for ax in 0..3 {
            min[ax] = min[ax].min(t.min[ax]);
            max[ax] = max[ax].max(t.max[ax]);
        }
    }
    (min, max)
}

fn raycast_node(
    node: &Node,
    mesh: &Mesh,
    origin: Vec3,
    dir: Vec3,
    max_dist: f32,
    best: &mut Option<RayHit>,
) {
    let (min, max) = match node {
        Node::Leaf { min, max, .. } | Node::Inner { min, max, .. } => (min, max),
    };
    if !ray_aabb_intersect(origin, dir, *min, *max, 0.0, max_dist) {
        return;
    }
    match node {
        Node::Leaf { tris, .. } => {
            for &ti in tris {
                let t = &mesh.tris[ti];
                let v0 = mesh.vertices[t.idx[0]];
                let v1 = mesh.vertices[t.idx[1]];
                let v2 = mesh.vertices[t.idx[2]];
                if let Some(hit_t) = ray_tri_intersect(origin, dir, v0, v1, v2) {
                    if hit_t < 0.0 || hit_t > max_dist {
                        continue;
                    }
                    match best {
                        Some(cur) if cur.t <= hit_t => {},
                        _ => {
                            *best = Some(RayHit {
                                tri_index: ti,
                                point: [origin[0], origin[1] - hit_t, origin[2]],
                                t: hit_t,
                            });
                        },
                    }
                }
            }
        },
        Node::Inner { left, right, .. } => {
            raycast_node(left, mesh, origin, dir, max_dist, best);
            raycast_node(right, mesh, origin, dir, max_dist, best);
        },
    }
}

fn ray_aabb_intersect(
    origin: Vec3,
    dir: Vec3,
    min: Vec3,
    max: Vec3,
    t_min: f32,
    t_max: f32,
) -> bool {
    let mut t0 = t_min;
    let mut t1 = t_max;
    for ax in 0..3 {
        let o = origin[ax];
        let d = dir[ax];
        if d.abs() < 1e-8 {
            if o < min[ax] || o > max[ax] {
                return false;
            }
            continue;
        }
        let inv = 1.0 / d;
        let mut ta = (min[ax] - o) * inv;
        let mut tb = (max[ax] - o) * inv;
        if ta > tb {
            std::mem::swap(&mut ta, &mut tb);
        }
        t0 = t0.max(ta);
        t1 = t1.min(tb);
        if t0 > t1 {
            return false;
        }
    }
    true
}

fn ray_tri_intersect(orig: Vec3, dir: Vec3, v0: Vec3, v1: Vec3, v2: Vec3) -> Option<f32> {
    let e1 = v_sub(v1, v0);
    let e2 = v_sub(v2, v0);
    let p = cross(dir, e2);
    let det = dot(e1, p);
    if det.abs() < 1e-8 {
        return None;
    }
    let inv_det = 1.0 / det;
    let tvec = v_sub(orig, v0);
    let u = dot(tvec, p) * inv_det;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(tvec, e1);
    let v = dot(dir, q) * inv_det;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = dot(e2, q) * inv_det;
    if t >= 0.0 {
        Some(t)
    } else {
        None
    }
}
