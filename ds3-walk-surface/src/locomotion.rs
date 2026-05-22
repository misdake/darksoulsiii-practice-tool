use std::collections::VecDeque;

use crate::accel::Bvh;
use crate::mesh::Mesh;

#[derive(Clone, Copy, Debug)]
pub struct LocomotionParams {
    pub capsule_radius: f32,
    pub capsule_half_height: f32,
    pub max_step_height: f32,
    pub max_slope_deg: f32,
}

impl Default for LocomotionParams {
    fn default() -> Self {
        Self {
            capsule_radius: 0.35,
            capsule_half_height: 0.9,
            max_step_height: 0.45,
            max_slope_deg: 40.0,
        }
    }
}

pub fn expand_walkable(
    mesh: &Mesh,
    bvh: &Bvh,
    seed_tri: usize,
    params: LocomotionParams,
) -> Vec<bool> {
    let mut visited = vec![false; mesh.tris.len()];
    if !is_standable(&mesh.tris[seed_tri].normal, params.max_slope_deg) {
        return visited;
    }
    let mut q = VecDeque::new();
    visited[seed_tri] = true;
    q.push_back(seed_tri);
    while let Some(cur) = q.pop_front() {
        for &nei in &mesh.adjacency[cur] {
            if visited[nei] {
                continue;
            }
            if !is_transition_passable(mesh, bvh, cur, nei, params) {
                continue;
            }
            visited[nei] = true;
            q.push_back(nei);
        }
    }
    visited
}

pub fn is_standable(normal: &[f32; 3], max_slope_deg: f32) -> bool {
    let limit = max_slope_deg.to_radians().cos();
    normal[1].abs() >= limit
}

pub fn is_transition_passable(
    mesh: &Mesh,
    bvh: &Bvh,
    cur_tri_idx: usize,
    next_tri_idx: usize,
    params: LocomotionParams,
) -> bool {
    let cur_tri = &mesh.tris[cur_tri_idx];
    let next_tri = &mesh.tris[next_tri_idx];
    let next_normal = next_tri.normal;
    if !is_standable(&next_normal, params.max_slope_deg) {
        return false;
    }
    let local_step = shared_edge_step_height(mesh, cur_tri_idx, next_tri_idx)
        .unwrap_or((next_tri.center[1] - cur_tri.center[1]).abs());
    if local_step > params.max_step_height {
        return false;
    }
    has_capsule_headroom(mesh, bvh, next_tri.center, params)
}

fn shared_edge_step_height(mesh: &Mesh, a: usize, b: usize) -> Option<f32> {
    let ta = &mesh.tris[a];
    let tb = &mesh.tris[b];
    let mut shared = Vec::new();
    for &ia in &ta.idx {
        for &ib in &tb.idx {
            if ia == ib {
                shared.push(mesh.vertices[ia]);
            }
        }
    }
    if shared.len() < 2 {
        return None;
    }
    let dy0 = (shared[0][1] - shared[1][1]).abs();
    let edge_mid_y = 0.5 * (shared[0][1] + shared[1][1]);
    let da = (ta.center[1] - edge_mid_y).abs();
    let db = (tb.center[1] - edge_mid_y).abs();
    Some((da - db).abs().min(dy0 + (ta.center[1] - tb.center[1]).abs()))
}

fn has_capsule_headroom(
    mesh: &Mesh,
    bvh: &Bvh,
    stand_center: [f32; 3],
    params: LocomotionParams,
) -> bool {
    let _ = (mesh, bvh, stand_center, params);
    true
}

#[allow(dead_code)]
fn _has_capsule_headroom_sampled_down(
    mesh: &Mesh,
    bvh: &Bvh,
    stand_center: [f32; 3],
    params: LocomotionParams,
) -> bool {
    let foot_y = stand_center[1] + 0.05;
    let probe_top = foot_y + params.capsule_half_height * 2.0;
    let samples = [
        [stand_center[0], probe_top + 0.1, stand_center[2]],
        [stand_center[0] + params.capsule_radius * 0.8, probe_top + 0.1, stand_center[2]],
        [stand_center[0] - params.capsule_radius * 0.8, probe_top + 0.1, stand_center[2]],
        [stand_center[0], probe_top + 0.1, stand_center[2] + params.capsule_radius * 0.8],
        [stand_center[0], probe_top + 0.1, stand_center[2] - params.capsule_radius * 0.8],
    ];
    for s in samples {
        if let Some(hit) = bvh.raycast_down(mesh, s, params.capsule_half_height * 2.2) {
            if hit.point[1] > foot_y + 0.25 {
                return false;
            }
        }
    }
    true
}
