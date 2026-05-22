mod accel;
mod collision_input;
mod export_debug;
mod geom;
mod locomotion;
mod mesh;
mod trajectory;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use accel::Bvh;
use anyhow::{Context, Result};
use export_debug::{write_meta_json, write_walkable_obj, OutputMeta};
use locomotion::{expand_walkable, LocomotionParams};
use trajectory::load_trajectory_points_internal;

const SEED_GAME: [f32; 3] = [27.8, -62.0, 524.3];

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let cfg = Config::from_args(&args)?;
    fs::create_dir_all(&cfg.out_dir).with_context(|| format!("mkdir {}", cfg.out_dir.display()))?;

    let mesh = collision_input::load_obj_meshes_from_dir(&cfg.collision_obj_dir)?;
    let bvh = Bvh::build(&mesh);
    let loco = LocomotionParams {
        max_step_height: cfg.max_step_height,
        max_slope_deg: cfg.max_slope_deg,
        ..LocomotionParams::default()
    };
    let min_normal_y_abs = loco.max_slope_deg.to_radians().cos();
    let seed_internal = SEED_GAME;
    let ground_origin = [seed_internal[0], seed_internal[1] + cfg.seed_cast_up, seed_internal[2]];
    let ground_hit = bvh
        .raycast_down_walkable(&mesh, ground_origin, cfg.seed_cast_max_dist, min_normal_y_abs)
        .context("seed down-raycast failed to find ground")?;
    let reached = expand_walkable(&mesh, &bvh, ground_hit.tri_index, loco);

    let out_obj = cfg.out_dir.join("walkable_m40_seed.obj");
    let out_meta = cfg.out_dir.join("walkable_m40_seed.meta.json");
    write_walkable_obj(&mesh, &reached, &out_obj)?;
    let reached_triangles = reached.iter().filter(|&&v| v).count();
    let meta = OutputMeta {
        map_id: "m40_00_00_00".to_string(),
        source_mesh: cfg.collision_obj_dir.to_string_lossy().to_string(),
        seed_game: SEED_GAME,
        seed_internal,
        grounded_point: ground_hit.point,
        reached_triangles,
        total_triangles: mesh.tris.len(),
    };
    write_meta_json(&meta, &out_meta)?;

    if let Some(traj_path) = cfg.trajectory_json.as_deref() {
        let pts = load_trajectory_points_internal(traj_path)?;
        let mut near_count = 0usize;
        for p in &pts {
            let o = [p[0], p[1] + 2.0, p[2]];
            if let Some(hit) = bvh.raycast_down_walkable(&mesh, o, 20.0, min_normal_y_abs) {
                if reached[hit.tri_index] {
                    near_count += 1;
                }
            }
        }
        println!(
            "trajectory coverage: {}/{} ({:.2}%)",
            near_count,
            pts.len(),
            if pts.is_empty() { 0.0 } else { near_count as f32 * 100.0 / pts.len() as f32 }
        );
    }

    println!(
        "done. reached {}/{} triangles. out: {}",
        reached_triangles,
        mesh.tris.len(),
        cfg.out_dir.display()
    );
    Ok(())
}

struct Config {
    collision_obj_dir: PathBuf,
    out_dir: PathBuf,
    trajectory_json: Option<PathBuf>,
    seed_cast_up: f32,
    seed_cast_max_dist: f32,
    max_step_height: f32,
    max_slope_deg: f32,
}

impl Config {
    fn from_args(args: &[String]) -> Result<Self> {
        let mut collision_obj_dir =
            PathBuf::from("ds3map/m40_00_00_00/collision_export_h40/binder_unpack/m40_00_00_00");
        let mut out_dir = PathBuf::from("map-work/walk-surface");
        let mut trajectory_json = Some(PathBuf::from("capture/cemetery_of_ash1/trajectory.json"));
        let mut seed_cast_up = 15.0f32;
        let mut seed_cast_max_dist = 200.0f32;
        let mut max_step_height = 0.45f32;
        let mut max_slope_deg = 40.0f32;
        let mut i = 1usize;
        while i < args.len() {
            match args[i].as_str() {
                "--collision-obj-dir" if i + 1 < args.len() => {
                    collision_obj_dir = PathBuf::from(&args[i + 1]);
                    i += 1;
                },
                "--out-dir" if i + 1 < args.len() => {
                    out_dir = PathBuf::from(&args[i + 1]);
                    i += 1;
                },
                "--trajectory-json" if i + 1 < args.len() => {
                    trajectory_json = Some(PathBuf::from(&args[i + 1]));
                    i += 1;
                },
                "--no-trajectory" => {
                    trajectory_json = None;
                },
                "--seed-cast-up" if i + 1 < args.len() => {
                    seed_cast_up = args[i + 1].parse().context("parse --seed-cast-up")?;
                    i += 1;
                },
                "--seed-cast-max-dist" if i + 1 < args.len() => {
                    seed_cast_max_dist =
                        args[i + 1].parse().context("parse --seed-cast-max-dist")?;
                    i += 1;
                },
                "--max-step-height" if i + 1 < args.len() => {
                    max_step_height = args[i + 1].parse().context("parse --max-step-height")?;
                    i += 1;
                },
                "--max-slope-deg" if i + 1 < args.len() => {
                    max_slope_deg = args[i + 1].parse().context("parse --max-slope-deg")?;
                    i += 1;
                },
                _ => {},
            }
            i += 1;
        }
        if !Path::new(&collision_obj_dir).is_dir() {
            anyhow::bail!("collision OBJ dir not found: {}", collision_obj_dir.display());
        }
        Ok(Self {
            collision_obj_dir,
            out_dir,
            trajectory_json,
            seed_cast_up,
            seed_cast_max_dist,
            max_step_height,
            max_slope_deg,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locomotion::{is_standable, is_transition_passable};
    use crate::mesh::Mesh;
    use crate::trajectory::{to_internal, CoordSpace};

    #[test]
    fn raycast_down_hits_topmost() {
        let vertices = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, -2.0, 0.0],
            [1.0, -2.0, 0.0],
            [0.0, -2.0, 1.0],
        ];
        let faces = vec![[0, 2, 1], [3, 5, 4]];
        let mesh = Mesh::from_vertices_indices(vertices, faces);
        let bvh = Bvh::build(&mesh);
        let hit = bvh.raycast_down(&mesh, [0.2, 5.0, 0.2], 10.0).expect("hit");
        assert!((hit.point[1] - 0.0).abs() < 1e-4);
    }

    #[test]
    fn coord_transform_keeps_game_z() {
        let p = [1.0, 2.0, 3.0];
        let got = to_internal(p, CoordSpace::Game);
        assert_eq!(got, [1.0, 2.0, 3.0]);
    }

    #[test]
    fn passability_boundaries() {
        assert!(is_standable(&[0.0, 1.0, 0.0], 40.0));
        assert!(!is_standable(&[1.0, 0.0, 0.0], 40.0));

        let vertices = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.4, 0.0],
            [2.0, 0.4, 0.0],
            [1.0, 0.4, 1.0],
        ];
        let faces = vec![[0, 2, 1], [3, 5, 4]];
        let mesh = Mesh::from_vertices_indices(vertices, faces);
        let bvh = Bvh::build(&mesh);
        let p = LocomotionParams { capsule_half_height: 0.1, ..LocomotionParams::default() };
        let ok = is_transition_passable(
            &mesh,
            &bvh,
            0,
            1,
            p,
        );
        assert!(ok);
    }
}
