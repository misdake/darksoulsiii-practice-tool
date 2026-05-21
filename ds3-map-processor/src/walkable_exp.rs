use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result};
use ds3_depthbuffer::linearize_depth;
use rayon::prelude::*;
use serde::Serialize;

use crate::coord_space::{convert_z, parse_coord_space, CoordSpace};
use crate::fs_utils::{find_all_toml_in_capture, group_tomls_by_first_subdir};
use crate::geom::{dist2_point_seg, point_in_polygon};
use crate::stage1_pointcloud::load_capture_from_toml;

const GRID_RES_WORLD: f32 = 0.125; // 1/8m
const NEG_RING_DIST_WORLD: f32 = 0.5;
const CAPSULE_HEIGHT_OFFSET: f32 = 0.45;
const CAPSULE_HEIGHT_WORLD: f32 = 1.5;
const CAPSULE_RADIUS_WORLD: f32 = 0.3;
const CAPSULE_MIN_SAMPLE_CELLS_FOR_OCC: u32 = 4;
const CAPSULE_CENTER_UPPER_MIN_POINTS: u32 = 4;
const CAPSULE_CENTER_RADIUS_WORLD: f32 = 0.10;
const CAPSULE_CENTER_UPPER_FLOOR: f32 = 0.25;
const CAPSULE_OCC_POINTS_PER_CELL_NORM: f32 = 6.0;
const MAX_PATH_DIST: i32 = 4;
const SEED_GAME: [f32; 3] = [27.8, -62.2, 524.3];
const POST_HOLE_MAX_CELLS: usize = 192;
const POST_CLOSING_RADIUS: i32 = 2;
const POST_OPENING_RADIUS: i32 = 1;
const POST_MAJORITY_NUM: usize = 4; // >=44% in 3x3, intentionally aggressive
const POST_MAJORITY_DEN: usize = 9;
const POST_PASSES: usize = 3;
const CAPSULE_DEBUG_AABB_MIN_X: f32 = 0.507;
const CAPSULE_DEBUG_AABB_MAX_X: f32 = 9.767;
const CAPSULE_DEBUG_AABB_MIN_Z: f32 = -452.601;
const CAPSULE_DEBUG_AABB_MAX_Z: f32 = -447.291;

#[derive(Clone, Copy)]
struct ParamSet {
    dh_dist1_max: f32,
    dh_dist2_max: f32,
    dh_dist3_max: f32,
    dh_dist4_max: f32,
    local_band_pad_down: f32,
    local_band_pad_up: f32,
    capsule_occ_max: f32,
    min_obs: u16,
    rollback_hysteresis: i16,
    min_positive_support: i16,
}

const PARAM: ParamSet = ParamSet {
    dh_dist1_max: 0.50,
    dh_dist2_max: 0.55,
    dh_dist3_max: 0.60,
    dh_dist4_max: 0.65,
    local_band_pad_down: 0.40,
    local_band_pad_up: 0.40,
    capsule_occ_max: 0.14,
    min_obs: 1,
    rollback_hysteresis: 2,
    min_positive_support: 1,
};

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum CellClass {
    #[default]
    Unknown,
    Walkable,
    Blocked,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FailReason {
    NoObs,
    LowObs,
    HeightBand,
    SupportPath,
    Capsule,
    Disconnected,
    Unknown,
}

#[derive(Clone, Copy, Default)]
struct CellState {
    class: CellClass,
    ground_y: Option<f32>,
    fail_reason: Option<FailReason>,
    walk_support: i16,
    block_support: i16,
}

#[derive(Default, Clone)]
struct ObsCell {
    min_y: f32,
    max_y: f32,
    count: u16,
    ys: Vec<f32>,
}

impl ObsCell {
    fn new(y: f32) -> Self {
        Self { min_y: y, max_y: y, count: 1, ys: vec![y] }
    }
    fn add(&mut self, y: f32) {
        self.min_y = self.min_y.min(y);
        self.max_y = self.max_y.max(y);
        self.count = self.count.saturating_add(1);
        self.ys.push(y);
    }
}

struct HeightEvent {
    step: usize,
    cell: (i32, i32),
    ground_y: f32,
}

#[derive(Clone)]
struct TrajectoryMask {
    poly: Vec<[f32; 2]>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LabelClass {
    Pos,
    Neg,
    Ignore,
}

#[derive(Clone)]
struct ShotData {
    toml_path: PathBuf,
    cam_cell: (i32, i32),
    cam_game: [f32; 3],
    cam_processor: [f32; 3],
    obs_raw: HashMap<(i32, i32), ObsCell>,
}

struct ExpansionResult {
    added: HashMap<(i32, i32), f32>,
    tested: HashSet<(i32, i32)>,
    failed: HashMap<(i32, i32), FailReason>,
    capsule_failed_details: HashMap<(i32, i32), CapsuleFailDetail>,
    stats: ExpansionStats,
}

#[derive(Default, Clone, Copy)]
struct ExpansionStats {
    tested: usize,
    no_obs: usize,
    low_obs: usize,
    band_fail: usize,
    support_fail: usize,
    capsule_fail: usize,
    passed: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CapsuleFailKind {
    CenterUpper,
    OccRatio,
}

#[derive(Clone, Copy)]
struct CapsuleFailDetail {
    kind: CapsuleFailKind,
    sample_cells: u32,
    occupied_cells: u32,
    occ_ratio: f32,
    center_upper_hits: u32,
    body_points_total: u32,
    occ_points_ratio: f32,
    low: f32,
    high: f32,
}

struct CapsuleAabbRow {
    step: usize,
    shot: String,
    ix: i32,
    iz: i32,
    x: f32,
    z: f32,
    ground: f32,
    kind: CapsuleFailKind,
    sample_cells: u32,
    occupied_cells: u32,
    occ_ratio: f32,
    center_upper_hits: u32,
    body_points_total: u32,
    occ_points_ratio: f32,
    low: f32,
    high: f32,
}

#[derive(Serialize)]
struct StepLog {
    step: usize,
    selected_shot: String,
    camera_position_game: [f32; 3],
    camera_position_processor: [f32; 3],
    score: f32,
    walkable_added: usize,
    walkable_total: usize,
    blocked_total: usize,
    frontier_total: usize,
}

#[derive(Serialize)]
struct EvalSummary {
    pos_total: usize,
    pos_walkable: usize,
    pos_recall: f32,
    neg_total: usize,
    neg_walkable: usize,
    neg_walkable_rate: f32,
}

#[derive(Serialize)]
struct SimReport {
    group: String,
    seed_game: [f32; 3],
    seed_processor: [f32; 3],
    params: ParamExport,
    steps: Vec<StepLog>,
    eval: EvalSummary,
    shots_total: usize,
    shots_used: usize,
}

#[derive(Serialize)]
struct ParamExport {
    dh_dist1_max: f32,
    dh_dist2_max: f32,
    dh_dist3_max: f32,
    dh_dist4_max: f32,
    local_band_pad_down: f32,
    local_band_pad_up: f32,
    capsule_occ_max: f32,
    min_obs: u16,
    rollback_hysteresis: i16,
    min_positive_support: i16,
}

#[derive(Serialize)]
struct RasterEntry {
    id: usize,
    step: Option<usize>,
    label: String,
    image: String,
    camera_position_game: Option<[f32; 3]>,
    min_x: f32,
    min_z: f32,
    width_px: u32,
    height_px: u32,
    grid_res_world: f32,
}

#[derive(Serialize)]
struct RasterIndex {
    group: String,
    entries: Vec<RasterEntry>,
}

#[derive(Clone, Copy)]
struct RasterBounds {
    min_ix: i32,
    min_iz: i32,
    min_x: f32,
    min_z: f32,
    width_px: u32,
    height_px: u32,
}

pub fn run_walkable_experiment(
    capture_dir: &Path,
    work_dir: &Path,
    selected_filter: Option<&[String]>,
) -> Result<()> {
    let out_root = work_dir.join("walkable-exp");
    fs::create_dir_all(&out_root).with_context(|| format!("mkdir {}", out_root.display()))?;
    let all = find_all_toml_in_capture(capture_dir)?;
    let groups = group_tomls_by_first_subdir(capture_dir, &all)?;

    let mut ran = 0usize;
    for (group, tomls) in groups {
        if let Some(filter) = selected_filter {
            if !filter.iter().any(|x| x == &group) {
                continue;
            }
        }
        let group_capture = capture_dir.join(&group);
        let traj_path = group_capture.join("trajectory.json");
        if !traj_path.is_file() {
            println!("walkable-exp skip {}: missing trajectory.json", group);
            continue;
        }

        let group_out = out_root.join(&group);
        fs::create_dir_all(&group_out).with_context(|| format!("mkdir {}", group_out.display()))?;
        let traj = load_trajectory_mask(&traj_path)?;
        let report = run_simulation(&group, &tomls, &traj, &group_out)?;
        let report_path = group_out.join("report.json");
        fs::write(
            &report_path,
            serde_json::to_vec_pretty(&report).context("serialize sim report")?,
        )
        .with_context(|| format!("write {}", report_path.display()))?;

        println!(
            "walkable-exp {} done: pos_recall={:.3} neg_walkable_rate={:.3} shots={}/{} -> {}",
            group,
            report.eval.pos_recall,
            report.eval.neg_walkable_rate,
            report.shots_used,
            report.shots_total,
            report_path.display()
        );
        ran += 1;
    }
    if ran == 0 {
        anyhow::bail!("walkable-exp: no groups processed");
    }
    Ok(())
}

fn run_simulation(
    group: &str,
    tomls: &[PathBuf],
    traj: &TrajectoryMask,
    out_root: &Path,
) -> Result<SimReport> {
    println!("walkable-exp [{}]: preload {} shots", group, tomls.len());
    let shots = preload_shots_parallel(tomls)?;

    let seed_proc = [SEED_GAME[0], SEED_GAME[1], -SEED_GAME[2]];
    let seed_cell = world_to_cell(seed_proc[0], seed_proc[2]);
    println!(
        "walkable-exp [{}]: seed game={:?} processor={:?} cell={:?}",
        group, SEED_GAME, seed_proc, seed_cell
    );

    let mut state = HashMap::<(i32, i32), CellState>::new();
    let mut walkable = HashMap::<(i32, i32), f32>::new();
    let mut blocked = HashMap::<(i32, i32), f32>::new();
    walkable.insert(seed_cell, seed_proc[1]);
    {
        let s = state.entry(seed_cell).or_default();
        s.class = CellClass::Walkable;
        s.ground_y = Some(seed_proc[1]);
        s.fail_reason = None;
    }

    let mut processed = vec![false; shots.len()];
    let mut logs = Vec::new();
    let mut height_events = Vec::<HeightEvent>::new();
    let mut capsule_aabb_rows = Vec::<CapsuleAabbRow>::new();
    let mut steps_without_add = 0usize;

    let rasters_dir = out_root.join("rasters");
    if rasters_dir.exists() {
        fs::remove_dir_all(&rasters_dir)
            .with_context(|| format!("remove_dir_all {}", rasters_dir.display()))?;
    }
    fs::create_dir_all(&rasters_dir).with_context(|| format!("mkdir {}", rasters_dir.display()))?;
    let mut raster_entries = Vec::<RasterEntry>::new();

    for step in 0..shots.len() {
        let frontier_cells = compute_frontier_cells(&walkable, &blocked);
        if frontier_cells.is_empty() {
            println!("  stop: frontier empty");
            break;
        }
        let Some((best_idx, best_score)) =
            pick_next_shot(&shots, &processed, &walkable, &blocked, &frontier_cells)
        else {
            break;
        };
        processed[best_idx] = true;

        let frontier_cells = compute_frontier_cells(&walkable, &blocked);
        let obs = &shots[best_idx].obs_raw;
        let prev_walkable = walkable.len();
        let expanded = expand_from_frontier(&frontier_cells, &walkable, &blocked, obs, PARAM);
        println!(
            "    expand stats: tested={} no_obs={} low_obs={} band_fail={} support_fail={} capsule_fail={} pass={}",
            expanded.stats.tested,
            expanded.stats.no_obs,
            expanded.stats.low_obs,
            expanded.stats.band_fail,
            expanded.stats.support_fail,
            expanded.stats.capsule_fail,
            expanded.stats.passed
        );
        for (&cell, &ground) in &expanded.added {
            let entry = state.entry(cell).or_default();
            entry.walk_support = entry.walk_support.saturating_add(1);
            if entry.walk_support >= PARAM.min_positive_support {
                entry.class = CellClass::Walkable;
                entry.ground_y = Some(ground);
                entry.fail_reason = None;
                walkable.insert(cell, ground);
                blocked.remove(&cell);
                height_events.push(HeightEvent { step: step + 1, cell, ground_y: ground });
            }
        }
        let shot_name = shots[best_idx]
            .toml_path
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or("unknown")
            .to_string();
        for (&cell, &d) in &expanded.capsule_failed_details {
            let (x, z) = cell_center_world(cell);
            if !point_in_aabb(x, z) {
                continue;
            }
            capsule_aabb_rows.push(CapsuleAabbRow {
                step: step + 1,
                shot: shot_name.clone(),
                ix: cell.0,
                iz: cell.1,
                x,
                z,
                ground: obs.get(&cell).map(|o| o.min_y).unwrap_or(0.0),
                kind: d.kind,
                sample_cells: d.sample_cells,
                occupied_cells: d.occupied_cells,
                occ_ratio: d.occ_ratio,
                center_upper_hits: d.center_upper_hits,
                body_points_total: d.body_points_total,
                occ_points_ratio: d.occ_points_ratio,
                low: d.low,
                high: d.high,
            });
        }
        // Only frontier-envelope cells that failed expansion gain block support.
        for &cell in &expanded.tested {
            if walkable.contains_key(&cell) || expanded.added.contains_key(&cell) {
                continue;
            }
            let Some(ob) = obs.get(&cell) else { continue };
            if ob.count < PARAM.min_obs {
                continue;
            }
            let entry = state.entry(cell).or_default();
            entry.block_support = entry.block_support.saturating_add(1);
            if entry.block_support - entry.walk_support >= PARAM.rollback_hysteresis {
                entry.class = CellClass::Blocked;
                entry.ground_y = None;
                entry.fail_reason =
                    expanded.failed.get(&cell).copied().or(Some(FailReason::Unknown));
                blocked.insert(cell, ob.min_y);
            }
        }
        retain_only_source_connected(seed_cell, &mut walkable, &mut state, &mut blocked);
        let added = walkable.len().saturating_sub(prev_walkable);
        if added == 0 {
            steps_without_add += 1;
        } else {
            steps_without_add = 0;
        }
        let frontier_now = compute_frontier_cells(&walkable, &blocked).len();
        logs.push(StepLog {
            step,
            selected_shot: shots[best_idx].toml_path.display().to_string(),
            camera_position_game: shots[best_idx].cam_game,
            camera_position_processor: shots[best_idx].cam_processor,
            score: best_score,
            walkable_added: added,
            walkable_total: walkable.len(),
            blocked_total: blocked.len(),
            frontier_total: frontier_now,
        });
        println!(
            "  progress {}/{} ({:.1}%) added={} walkable={} frontier={} score={:.1}",
            step + 1,
            shots.len(),
            ((step + 1) as f32 / shots.len().max(1) as f32) * 100.0,
            added,
            walkable.len(),
            frontier_now,
            best_score
        );
        if steps_without_add >= 8 {
            let remaining_with_gain =
                has_promising_unprocessed(&shots, &processed, &walkable, &blocked);
            if !remaining_with_gain {
                println!(
                    "  stop: no new walkable for {} steps and no promising shots",
                    steps_without_add
                );
                break;
            }
        }
    }

    println!("  finalize: evaluating");
    let eval = evaluate_result(&state, traj);
    let img_name = "sim_walkable.png";
    let img_path = rasters_dir.join(img_name);
    println!("  finalize: writing {}", img_name);
    let rb = write_state_raster(&img_path, &state)?;
    let eval_name = "sim_eval_mismatch.png";
    let eval_path = rasters_dir.join(eval_name);
    println!("  finalize: writing {}", eval_name);
    write_eval_mismatch_raster(&eval_path, &state, traj, rb)?;
    apply_final_mask_postprocess(seed_cell, &mut walkable, &mut blocked, &mut state);
    let post_img_name = "sim_walkable_post.png";
    let post_img_path = rasters_dir.join(post_img_name);
    println!("  finalize: writing {}", post_img_name);
    let post_rb = write_walkable_only_raster(&post_img_path, &state)?;
    raster_entries.push(RasterEntry {
        id: raster_entries.len() + 1,
        step: None,
        label: format!(
            "final sim walkable seed=({:.1},{:.1},{:.1}) d1={} d2={} d3={} d4={} occ={}",
            SEED_GAME[0],
            SEED_GAME[1],
            SEED_GAME[2],
            PARAM.dh_dist1_max,
            PARAM.dh_dist2_max,
            PARAM.dh_dist3_max,
            PARAM.dh_dist4_max,
            PARAM.capsule_occ_max
        ),
        image: format!("rasters/{}", img_name),
        camera_position_game: None,
        min_x: rb.min_x,
        min_z: rb.min_z,
        width_px: rb.width_px,
        height_px: rb.height_px,
        grid_res_world: GRID_RES_WORLD,
    });
    raster_entries.push(RasterEntry {
        id: raster_entries.len() + 1,
        step: None,
        label: "final sim walkable postprocessed (green only)".to_string(),
        image: format!("rasters/{}", post_img_name),
        camera_position_game: None,
        min_x: post_rb.min_x,
        min_z: post_rb.min_z,
        width_px: post_rb.width_px,
        height_px: post_rb.height_px,
        grid_res_world: GRID_RES_WORLD,
    });
    raster_entries.push(RasterEntry {
        id: raster_entries.len() + 1,
        step: None,
        label: "final eval mismatch (blue=pos miss, magenta=neg false walk)".to_string(),
        image: format!("rasters/{}", eval_name),
        camera_position_game: None,
        min_x: rb.min_x,
        min_z: rb.min_z,
        width_px: rb.width_px,
        height_px: rb.height_px,
        grid_res_world: GRID_RES_WORLD,
    });

    let index = RasterIndex { group: group.to_string(), entries: raster_entries };
    fs::write(
        rasters_dir.join("index.json"),
        serde_json::to_vec_pretty(&index).context("serialize raster index")?,
    )
    .with_context(|| format!("write {}", rasters_dir.join("index.json").display()))?;
    println!("  finalize: writing walkable_height_events.csv");
    write_height_events_csv(&out_root.join("walkable_height_events.csv"), &height_events)?;
    println!("  finalize: writing walkable_heights.csv");
    write_final_heights_csv(&out_root.join("walkable_heights.csv"), &state)?;
    println!("  finalize: writing capsule_aabb_fail_details.csv");
    write_capsule_aabb_rows_csv(&out_root.join("capsule_aabb_fail_details.csv"), &capsule_aabb_rows)?;
    println!("  finalize: writing capsule_aabb_fail_summary.txt");
    write_capsule_aabb_summary(
        &out_root.join("capsule_aabb_fail_summary.txt"),
        &capsule_aabb_rows,
    )?;

    Ok(SimReport {
        group: group.to_string(),
        seed_game: SEED_GAME,
        seed_processor: seed_proc,
        params: ParamExport {
            dh_dist1_max: PARAM.dh_dist1_max,
            dh_dist2_max: PARAM.dh_dist2_max,
            dh_dist3_max: PARAM.dh_dist3_max,
            dh_dist4_max: PARAM.dh_dist4_max,
            local_band_pad_down: PARAM.local_band_pad_down,
            local_band_pad_up: PARAM.local_band_pad_up,
            capsule_occ_max: PARAM.capsule_occ_max,
            min_obs: PARAM.min_obs,
            rollback_hysteresis: PARAM.rollback_hysteresis,
            min_positive_support: PARAM.min_positive_support,
        },
        steps: logs,
        eval,
        shots_total: shots.len(),
        shots_used: processed.iter().filter(|&&x| x).count(),
    })
}

fn preload_shot(toml_path: &Path) -> Result<ShotData> {
    let capture = load_capture_from_toml(toml_path)?;
    let cam_game = capture.camera_position;
    let cam_proc =
        [capture.camera_position[0], capture.camera_position[1], -capture.camera_position[2]];
    let cam_cell = world_to_cell(cam_proc[0], cam_proc[2]);
    let obs = build_observation_grid_from_capture(&capture);
    Ok(ShotData {
        toml_path: toml_path.to_path_buf(),
        cam_cell,
        cam_game,
        cam_processor: cam_proc,
        obs_raw: obs,
    })
}

fn preload_shots_parallel(tomls: &[PathBuf]) -> Result<Vec<ShotData>> {
    if tomls.is_empty() {
        return Ok(Vec::new());
    }

    let worker_count =
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8).min(tomls.len());
    println!("  preload threads: {}", worker_count);
    let done = AtomicUsize::new(0);
    let total = tomls.len();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(worker_count)
        .build()
        .context("build rayon pool for preload")?;

    let mut rows = pool.install(|| {
        tomls
            .par_iter()
            .enumerate()
            .map(|(idx, path)| {
                let shot = preload_shot(path)
                    .with_context(|| format!("preload failed at index {}", idx))?;
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n.is_multiple_of(10) || n == total {
                    println!("  preload progress: {}/{}", n, total);
                }
                Ok::<(usize, ShotData), anyhow::Error>((idx, shot))
            })
            .collect::<Result<Vec<_>>>()
    })?;

    rows.sort_unstable_by_key(|(idx, _)| *idx);
    Ok(rows.into_iter().map(|(_, shot)| shot).collect())
}

fn pick_next_shot(
    shots: &[ShotData],
    processed: &[bool],
    walkable: &HashMap<(i32, i32), f32>,
    blocked: &HashMap<(i32, i32), f32>,
    frontier: &[(i32, i32)],
) -> Option<(usize, f32)> {
    if frontier.is_empty() {
        return None;
    }
    let front_centroid = centroid_cell(frontier.iter().copied());
    let mut best: Option<(usize, f32)> = None;
    for (i, s) in shots.iter().enumerate() {
        if processed[i] {
            continue;
        }
        let score = score_shot_for_frontier(s, walkable, blocked, frontier, front_centroid);
        match best {
            Some((_, bs)) if bs >= score => {},
            _ => best = Some((i, score)),
        }
    }
    best.filter(|(_, score)| *score > 0.0)
}

fn has_promising_unprocessed(
    shots: &[ShotData],
    processed: &[bool],
    walkable: &HashMap<(i32, i32), f32>,
    blocked: &HashMap<(i32, i32), f32>,
) -> bool {
    for (i, s) in shots.iter().enumerate() {
        if processed[i] {
            continue;
        }
        let frontier = compute_frontier_cells(walkable, blocked);
        if frontier.is_empty() {
            return false;
        }
        let front_centroid = centroid_cell(frontier.iter().copied());
        if score_shot_for_frontier(s, walkable, blocked, &frontier, front_centroid) > 0.0 {
            return true;
        }
    }
    false
}

fn score_shot_for_frontier(
    shot: &ShotData,
    walkable: &HashMap<(i32, i32), f32>,
    blocked: &HashMap<(i32, i32), f32>,
    frontier: &[(i32, i32)],
    front_centroid: (i32, i32),
) -> f32 {
    if frontier.is_empty() {
        return 0.0;
    }
    let mut tested = HashSet::<(i32, i32)>::new();
    let mut observed_candidates = 0u32;
    let mut locally_supported = 0u32;
    let mut frontier_observed = 0u32;
    for &f in frontier {
        if shot.obs_raw.contains_key(&f) {
            frontier_observed += 1;
        }
        for n in neighbors4(f) {
            if walkable.contains_key(&n) || blocked.contains_key(&n) || !tested.insert(n) {
                continue;
            }
            let Some(ob) = shot.obs_raw.get(&n) else { continue };
            if ob.count < PARAM.min_obs {
                continue;
            }
            observed_candidates += 1;
            let ground = ob.min_y;
            if local_height_band_pass(n, ground, walkable, PARAM)
                && has_support_path(n, ground, walkable, PARAM)
            {
                locally_supported += 1;
            }
        }
    }
    let d_front = dist_cells(shot.cam_cell, front_centroid);
    let camera_tiebreak = 1.0 / (1.0 + d_front);
    locally_supported as f32 * 10.0
        + observed_candidates as f32
        + frontier_observed as f32 * 0.05
        + camera_tiebreak * 0.01
}

fn compute_frontier_cells(
    walkable: &HashMap<(i32, i32), f32>,
    blocked: &HashMap<(i32, i32), f32>,
) -> Vec<(i32, i32)> {
    let mut out = Vec::new();
    for &c in walkable.keys() {
        if has_unknown_neighbor(c, walkable, blocked) {
            out.push(c);
        }
    }
    out
}

fn evaluate_result(state: &HashMap<(i32, i32), CellState>, traj: &TrajectoryMask) -> EvalSummary {
    let mut min_ix = i32::MAX;
    let mut max_ix = i32::MIN;
    let mut min_iz = i32::MAX;
    let mut max_iz = i32::MIN;
    for &(ix, iz) in state.keys() {
        min_ix = min_ix.min(ix);
        max_ix = max_ix.max(ix);
        min_iz = min_iz.min(iz);
        max_iz = max_iz.max(iz);
    }
    if min_ix > max_ix || min_iz > max_iz {
        return EvalSummary {
            pos_total: 0,
            pos_walkable: 0,
            pos_recall: 0.0,
            neg_total: 0,
            neg_walkable: 0,
            neg_walkable_rate: 0.0,
        };
    }
    let mut pos_total = 0usize;
    let mut pos_walk = 0usize;
    let mut neg_total = 0usize;
    let mut neg_walk = 0usize;
    for iz in min_iz..=max_iz {
        for ix in min_ix..=max_ix {
            let label = classify_label((ix, iz), traj);
            if label == LabelClass::Ignore {
                continue;
            }
            let walk =
                state.get(&(ix, iz)).map(|s| s.class == CellClass::Walkable).unwrap_or(false);
            match label {
                LabelClass::Pos => {
                    pos_total += 1;
                    if walk {
                        pos_walk += 1;
                    }
                },
                LabelClass::Neg => {
                    neg_total += 1;
                    if walk {
                        neg_walk += 1;
                    }
                },
                LabelClass::Ignore => {},
            }
        }
    }
    EvalSummary {
        pos_total,
        pos_walkable: pos_walk,
        pos_recall: if pos_total == 0 { 0.0 } else { pos_walk as f32 / pos_total as f32 },
        neg_total,
        neg_walkable: neg_walk,
        neg_walkable_rate: if neg_total == 0 { 0.0 } else { neg_walk as f32 / neg_total as f32 },
    }
}

fn write_state_raster(path: &Path, state: &HashMap<(i32, i32), CellState>) -> Result<RasterBounds> {
    let mut walkable = HashSet::new();
    let mut blocked = HashSet::new();
    for (&k, v) in state {
        match v.class {
            CellClass::Walkable => {
                walkable.insert(k);
            },
            CellClass::Blocked => {
                blocked.insert(k);
            },
            CellClass::Unknown => {},
        }
    }
    if walkable.is_empty() && blocked.is_empty() {
        let img = image::RgbaImage::new(1, 1);
        img.save(path).with_context(|| format!("save {}", path.display()))?;
        return Ok(RasterBounds {
            min_ix: 0,
            min_iz: 0,
            min_x: 0.0,
            min_z: 0.0,
            width_px: 1,
            height_px: 1,
        });
    }
    let mut min_ix = i32::MAX;
    let mut max_ix = i32::MIN;
    let mut min_iz = i32::MAX;
    let mut max_iz = i32::MIN;
    for &(ix, iz) in walkable.iter().chain(blocked.iter()) {
        min_ix = min_ix.min(ix);
        max_ix = max_ix.max(ix);
        min_iz = min_iz.min(iz);
        max_iz = max_iz.max(iz);
    }
    let pad = 2i32;
    min_ix -= pad;
    min_iz -= pad;
    max_ix += pad;
    max_iz += pad;
    let w = (max_ix - min_ix + 1).max(1) as u32;
    let h = (max_iz - min_iz + 1).max(1) as u32;
    let mut img = image::RgbaImage::new(w, h);
    for (&(ix, iz), v) in state {
        let x = (ix - min_ix) as u32;
        let y = (iz - min_iz) as u32;
        let px = match v.class {
            CellClass::Walkable => image::Rgba([20, 220, 110, 150]),
            CellClass::Blocked => match v.fail_reason.unwrap_or(FailReason::Unknown) {
                FailReason::NoObs => image::Rgba([120, 120, 120, 130]),
                FailReason::LowObs => image::Rgba([110, 160, 255, 130]),
                FailReason::HeightBand => image::Rgba([255, 170, 60, 130]),
                FailReason::SupportPath => image::Rgba([255, 80, 80, 130]),
                FailReason::Capsule => image::Rgba([210, 70, 220, 130]),
                FailReason::Disconnected => image::Rgba([80, 255, 255, 130]),
                FailReason::Unknown => image::Rgba([220, 60, 40, 110]),
            },
            CellClass::Unknown => image::Rgba([0, 0, 0, 0]),
        };
        if px.0[3] > 0 {
            img.put_pixel(x, y, px);
        }
    }
    for &(ix, iz) in &walkable {
        if has_unknown_neighbor_set((ix, iz), &walkable, &blocked) {
            let x = (ix - min_ix) as u32;
            let y = (iz - min_iz) as u32;
            img.put_pixel(x, y, image::Rgba([255, 216, 64, 190]));
        }
    }
    img.save(path).with_context(|| format!("save {}", path.display()))?;
    Ok(RasterBounds {
        min_ix,
        min_iz,
        min_x: min_ix as f32 * GRID_RES_WORLD,
        min_z: min_iz as f32 * GRID_RES_WORLD,
        width_px: w,
        height_px: h,
    })
}

fn write_walkable_only_raster(
    path: &Path,
    state: &HashMap<(i32, i32), CellState>,
) -> Result<RasterBounds> {
    let mut walkable = HashSet::new();
    for (&k, v) in state {
        if v.class == CellClass::Walkable {
            walkable.insert(k);
        }
    }
    if walkable.is_empty() {
        let img = image::RgbaImage::new(1, 1);
        img.save(path).with_context(|| format!("save {}", path.display()))?;
        return Ok(RasterBounds {
            min_ix: 0,
            min_iz: 0,
            min_x: 0.0,
            min_z: 0.0,
            width_px: 1,
            height_px: 1,
        });
    }
    let mut min_ix = i32::MAX;
    let mut max_ix = i32::MIN;
    let mut min_iz = i32::MAX;
    let mut max_iz = i32::MIN;
    for &(ix, iz) in &walkable {
        min_ix = min_ix.min(ix);
        max_ix = max_ix.max(ix);
        min_iz = min_iz.min(iz);
        max_iz = max_iz.max(iz);
    }
    let pad = 2i32;
    min_ix -= pad;
    min_iz -= pad;
    max_ix += pad;
    max_iz += pad;
    let w = (max_ix - min_ix + 1).max(1) as u32;
    let h = (max_iz - min_iz + 1).max(1) as u32;
    let mut img = image::RgbaImage::new(w, h);
    for &(ix, iz) in &walkable {
        let x = (ix - min_ix) as u32;
        let y = (iz - min_iz) as u32;
        img.put_pixel(x, y, image::Rgba([20, 220, 110, 180]));
    }
    img.save(path).with_context(|| format!("save {}", path.display()))?;
    Ok(RasterBounds {
        min_ix,
        min_iz,
        min_x: min_ix as f32 * GRID_RES_WORLD,
        min_z: min_iz as f32 * GRID_RES_WORLD,
        width_px: w,
        height_px: h,
    })
}

fn write_eval_mismatch_raster(
    path: &Path,
    state: &HashMap<(i32, i32), CellState>,
    traj: &TrajectoryMask,
    rb: RasterBounds,
) -> Result<()> {
    let mut img = image::RgbaImage::new(rb.width_px, rb.height_px);
    for py in 0..rb.height_px {
        for px in 0..rb.width_px {
            let ix = rb.min_ix + px as i32;
            let iz = rb.min_iz + py as i32;
            let label = classify_label((ix, iz), traj);
            if label == LabelClass::Ignore {
                continue;
            }
            let walk =
                state.get(&(ix, iz)).map(|s| s.class == CellClass::Walkable).unwrap_or(false);
            let color = match (label, walk) {
                (LabelClass::Pos, false) => Some(image::Rgba([80, 160, 255, 220])),
                (LabelClass::Neg, true) => Some(image::Rgba([255, 40, 220, 220])),
                _ => None,
            };
            if let Some(c) = color {
                img.put_pixel(px, py, c);
            }
        }
    }
    img.save(path).with_context(|| format!("save {}", path.display()))?;
    Ok(())
}

fn write_height_events_csv(path: &Path, events: &[HeightEvent]) -> Result<()> {
    let mut f = fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    writeln!(f, "step,ix,iz,x,z,ground_y").context("write height event header")?;
    let total = events.len();
    for (i, e) in events.iter().enumerate() {
        let x = (e.cell.0 as f32 + 0.5) * GRID_RES_WORLD;
        let z = (e.cell.1 as f32 + 0.5) * GRID_RES_WORLD;
        writeln!(f, "{},{},{},{:.6},{:.6},{:.6}", e.step, e.cell.0, e.cell.1, x, z, e.ground_y)
            .context("write height event row")?;
        if (i + 1) % 50_000 == 0 || i + 1 == total {
            println!("    height_events.csv: {}/{}", i + 1, total);
        }
    }
    Ok(())
}

fn write_final_heights_csv(path: &Path, state: &HashMap<(i32, i32), CellState>) -> Result<()> {
    let mut rows = state
        .iter()
        .filter_map(|(&cell, s)| {
            if s.class == CellClass::Walkable {
                s.ground_y.map(|h| (cell, h))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    rows.sort_unstable_by_key(|(cell, _)| (cell.1, cell.0));

    let mut f = fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    writeln!(f, "ix,iz,x,z,ground_y").context("write final height header")?;
    let total = rows.len();
    for (i, (cell, ground_y)) in rows.into_iter().enumerate() {
        let x = (cell.0 as f32 + 0.5) * GRID_RES_WORLD;
        let z = (cell.1 as f32 + 0.5) * GRID_RES_WORLD;
        writeln!(f, "{},{},{:.6},{:.6},{:.6}", cell.0, cell.1, x, z, ground_y)
            .context("write final height row")?;
        if (i + 1) % 50_000 == 0 || i + 1 == total {
            println!("    walkable_heights.csv: {}/{}", i + 1, total);
        }
    }
    Ok(())
}

fn write_capsule_aabb_rows_csv(path: &Path, rows: &[CapsuleAabbRow]) -> Result<()> {
    let mut f = fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    writeln!(
        f,
        "step,shot,ix,iz,x,z,ground,kind,sample_cells,occupied_cells,occ_ratio,center_upper_hits,body_points_total,occ_points_ratio,low,high"
    )
    .context("write capsule aabb header")?;
    for r in rows {
        writeln!(
            f,
            "{},\"{}\",{},{},{:.6},{:.6},{:.6},{},{},{},{:.6},{},{},{:.6},{:.6},{:.6}",
            r.step,
            r.shot.replace('"', "'"),
            r.ix,
            r.iz,
            r.x,
            r.z,
            r.ground,
            capsule_fail_kind_name(r.kind),
            r.sample_cells,
            r.occupied_cells,
            r.occ_ratio,
            r.center_upper_hits,
            r.body_points_total,
            r.occ_points_ratio,
            r.low,
            r.high
        )
        .context("write capsule aabb row")?;
    }
    Ok(())
}

fn write_capsule_aabb_summary(path: &Path, rows: &[CapsuleAabbRow]) -> Result<()> {
    let mut center_upper = 0usize;
    let mut occ_ratio = 0usize;
    let mut sum_ratio = 0.0f64;
    let mut sum_points_ratio = 0.0f64;
    let mut sum_sample = 0u64;
    let mut sum_occupied = 0u64;
    for r in rows {
        match r.kind {
            CapsuleFailKind::CenterUpper => center_upper += 1,
            CapsuleFailKind::OccRatio => occ_ratio += 1,
        }
        sum_ratio += r.occ_ratio as f64;
        sum_points_ratio += r.occ_points_ratio as f64;
        sum_sample += r.sample_cells as u64;
        sum_occupied += r.occupied_cells as u64;
    }
    let total = rows.len();
    let avg_ratio = if total == 0 { 0.0 } else { sum_ratio / total as f64 };
    let avg_points_ratio = if total == 0 { 0.0 } else { sum_points_ratio / total as f64 };
    let avg_sample = if total == 0 { 0.0 } else { sum_sample as f64 / total as f64 };
    let avg_occupied = if total == 0 { 0.0 } else { sum_occupied as f64 / total as f64 };
    let mut f = fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    writeln!(f, "aabb: x=[{:.3},{:.3}] z=[{:.3},{:.3}]", CAPSULE_DEBUG_AABB_MIN_X, CAPSULE_DEBUG_AABB_MAX_X, CAPSULE_DEBUG_AABB_MIN_Z, CAPSULE_DEBUG_AABB_MAX_Z)?;
    writeln!(f, "total_rows: {}", total)?;
    writeln!(f, "center_upper_fail: {}", center_upper)?;
    writeln!(f, "occ_ratio_fail: {}", occ_ratio)?;
    writeln!(f, "avg_occ_ratio: {:.6}", avg_ratio)?;
    writeln!(f, "avg_occ_points_ratio: {:.6}", avg_points_ratio)?;
    writeln!(f, "avg_sample_cells: {:.3}", avg_sample)?;
    writeln!(f, "avg_occupied_cells: {:.3}", avg_occupied)?;
    println!(
        "  capsule-aabb summary: rows={} center_upper={} occ_ratio={} avg_occ_ratio={:.3} avg_occ_points_ratio={:.3}",
        total, center_upper, occ_ratio, avg_ratio, avg_points_ratio
    );
    Ok(())
}

fn capsule_fail_kind_name(k: CapsuleFailKind) -> &'static str {
    match k {
        CapsuleFailKind::CenterUpper => "CenterUpper",
        CapsuleFailKind::OccRatio => "OccRatio",
    }
}

fn point_in_aabb(x: f32, z: f32) -> bool {
    (CAPSULE_DEBUG_AABB_MIN_X..=CAPSULE_DEBUG_AABB_MAX_X).contains(&x)
        && (CAPSULE_DEBUG_AABB_MIN_Z..=CAPSULE_DEBUG_AABB_MAX_Z).contains(&z)
}

fn cell_center_world(cell: (i32, i32)) -> (f32, f32) {
    (
        (cell.0 as f32 + 0.5) * GRID_RES_WORLD,
        (cell.1 as f32 + 0.5) * GRID_RES_WORLD,
    )
}

fn expand_from_frontier(
    frontier: &[(i32, i32)],
    walkable: &HashMap<(i32, i32), f32>,
    blocked: &HashMap<(i32, i32), f32>,
    obs: &HashMap<(i32, i32), ObsCell>,
    p: ParamSet,
) -> ExpansionResult {
    let mut known = walkable.clone();
    let mut total_added = HashMap::<(i32, i32), f32>::new();
    let mut tested_all = HashSet::<(i32, i32)>::new();
    let mut failed = HashMap::<(i32, i32), FailReason>::new();
    let mut capsule_failed_details = HashMap::<(i32, i32), CapsuleFailDetail>::new();
    let mut stats = ExpansionStats::default();
    let mut frontier_now =
        frontier.iter().copied().filter(|c| known.contains_key(c)).collect::<Vec<_>>();
    loop {
        if frontier_now.is_empty() {
            break;
        }
        let mut wave_added = HashMap::<(i32, i32), f32>::new();
        let mut wave_tested = HashSet::<(i32, i32)>::new();
        for &f in &frontier_now {
            for n in neighbors4(f) {
                if blocked.contains_key(&n) || known.contains_key(&n) || wave_tested.contains(&n) {
                    continue;
                }
                wave_tested.insert(n);
                tested_all.insert(n);
                stats.tested += 1;
                let Some(ob) = obs.get(&n) else {
                    stats.no_obs += 1;
                    failed.entry(n).or_insert(FailReason::NoObs);
                    continue;
                };
                if ob.count < p.min_obs {
                    stats.low_obs += 1;
                    failed.entry(n).or_insert(FailReason::LowObs);
                    continue;
                }
                let ground = ob.min_y;
                if !local_height_band_pass(n, ground, &known, p) {
                    stats.band_fail += 1;
                    failed.entry(n).or_insert(FailReason::HeightBand);
                    continue;
                }
                if !has_support_path(n, ground, &known, p) {
                    stats.support_fail += 1;
                    failed.entry(n).or_insert(FailReason::SupportPath);
                    continue;
                }
                if let Some(d) = capsule_check_detail(n, ground, obs, p) {
                    stats.capsule_fail += 1;
                    failed.entry(n).or_insert(FailReason::Capsule);
                    capsule_failed_details.entry(n).or_insert(d);
                    continue;
                }
                stats.passed += 1;
                wave_added.insert(n, ground);
            }
        }
        if wave_added.is_empty() {
            break;
        }
        for (&cell, &h) in &wave_added {
            known.insert(cell, h);
            total_added.insert(cell, h);
        }
        frontier_now = wave_added.keys().copied().collect();
    }
    ExpansionResult {
        added: total_added,
        tested: tested_all,
        failed,
        capsule_failed_details,
        stats,
    }
}

fn retain_only_source_connected(
    source_cell: (i32, i32),
    walkable: &mut HashMap<(i32, i32), f32>,
    state: &mut HashMap<(i32, i32), CellState>,
    blocked: &mut HashMap<(i32, i32), f32>,
) {
    if walkable.is_empty() || !walkable.contains_key(&source_cell) {
        return;
    }
    let mut visited = HashSet::<(i32, i32)>::new();
    let mut q = VecDeque::<(i32, i32)>::new();
    visited.insert(source_cell);
    q.push_back(source_cell);
    while let Some((x, z)) = q.pop_front() {
        for n in neighbors4((x, z)) {
            if visited.contains(&n) || !walkable.contains_key(&n) {
                continue;
            }
            visited.insert(n);
            q.push_back(n);
        }
    }
    let mut to_drop = Vec::new();
    for (&k, &v) in walkable.iter() {
        if !visited.contains(&k) {
            to_drop.push((k, v));
        }
    }
    for (k, v) in to_drop {
        walkable.remove(&k);
        blocked.insert(k, v);
        if let Some(s) = state.get_mut(&k) {
            s.class = CellClass::Blocked;
            s.ground_y = None;
            s.fail_reason = Some(FailReason::Disconnected);
            s.block_support = s.block_support.saturating_add(1);
        }
    }
}

fn apply_final_mask_postprocess(
    source_cell: (i32, i32),
    walkable: &mut HashMap<(i32, i32), f32>,
    blocked: &mut HashMap<(i32, i32), f32>,
    state: &mut HashMap<(i32, i32), CellState>,
) {
    if walkable.is_empty() || !walkable.contains_key(&source_cell) {
        return;
    }
    let mut mask: HashSet<(i32, i32)> = walkable.keys().copied().collect();
    for _ in 0..POST_PASSES {
        mask = fill_small_holes(&mask, POST_HOLE_MAX_CELLS);
        mask = morph_open(&mask, POST_OPENING_RADIUS);
        mask = morph_close(&mask, POST_CLOSING_RADIUS);
        mask = majority_filter_3x3(&mask, POST_MAJORITY_NUM, POST_MAJORITY_DEN);
    }

    let before = walkable.clone();
    for (&cell, &h) in &before {
        if !mask.contains(&cell) {
            walkable.remove(&cell);
            blocked.insert(cell, h);
            if let Some(s) = state.get_mut(&cell) {
                s.class = CellClass::Blocked;
                s.ground_y = None;
                s.fail_reason = Some(FailReason::Unknown);
            }
        }
    }
    for &cell in &mask {
        if walkable.contains_key(&cell) {
            continue;
        }
        let h = estimate_ground_for_post(cell, walkable, blocked, state).unwrap_or(0.0);
        walkable.insert(cell, h);
        blocked.remove(&cell);
        let s = state.entry(cell).or_default();
        s.class = CellClass::Walkable;
        s.ground_y = Some(h);
        s.fail_reason = None;
        s.walk_support = s.walk_support.saturating_add(1);
    }
}

fn fill_small_holes(mask: &HashSet<(i32, i32)>, max_cells: usize) -> HashSet<(i32, i32)> {
    if mask.is_empty() {
        return HashSet::new();
    }
    let (min_x, max_x, min_z, max_z) = bounds_of_set(mask);
    let mut out = mask.clone();
    let mut seen = HashSet::<(i32, i32)>::new();
    for z in min_z..=max_z {
        for x in min_x..=max_x {
            let c = (x, z);
            if out.contains(&c) || seen.contains(&c) {
                continue;
            }
            let mut q = VecDeque::new();
            let mut comp = Vec::new();
            let mut touches_border = false;
            seen.insert(c);
            q.push_back(c);
            while let Some(cur) = q.pop_front() {
                comp.push(cur);
                if cur.0 == min_x || cur.0 == max_x || cur.1 == min_z || cur.1 == max_z {
                    touches_border = true;
                }
                for n in neighbors4(cur) {
                    if n.0 < min_x || n.0 > max_x || n.1 < min_z || n.1 > max_z {
                        continue;
                    }
                    if out.contains(&n) || seen.contains(&n) {
                        continue;
                    }
                    seen.insert(n);
                    q.push_back(n);
                }
            }
            if !touches_border && comp.len() <= max_cells {
                for cc in comp {
                    out.insert(cc);
                }
            }
        }
    }
    out
}

fn morph_close(mask: &HashSet<(i32, i32)>, radius: i32) -> HashSet<(i32, i32)> {
    let dilated = dilate(mask, radius);
    erode(&dilated, radius)
}

fn morph_open(mask: &HashSet<(i32, i32)>, radius: i32) -> HashSet<(i32, i32)> {
    let eroded = erode(mask, radius);
    dilate(&eroded, radius)
}

fn dilate(mask: &HashSet<(i32, i32)>, radius: i32) -> HashSet<(i32, i32)> {
    let mut out = HashSet::new();
    for &c in mask {
        for dz in -radius..=radius {
            for dx in -radius..=radius {
                if dx.abs() + dz.abs() > radius {
                    continue;
                }
                out.insert((c.0 + dx, c.1 + dz));
            }
        }
    }
    out
}

fn erode(mask: &HashSet<(i32, i32)>, radius: i32) -> HashSet<(i32, i32)> {
    if mask.is_empty() {
        return HashSet::new();
    }
    let (min_x, max_x, min_z, max_z) = bounds_of_set(mask);
    let mut out = HashSet::new();
    for z in min_z..=max_z {
        for x in min_x..=max_x {
            let c = (x, z);
            if !mask.contains(&c) {
                continue;
            }
            let mut ok = true;
            'chk: for dz in -radius..=radius {
                for dx in -radius..=radius {
                    if dx.abs() + dz.abs() > radius {
                        continue;
                    }
                    if !mask.contains(&(x + dx, z + dz)) {
                        ok = false;
                        break 'chk;
                    }
                }
            }
            if ok {
                out.insert(c);
            }
        }
    }
    out
}

fn majority_filter_3x3(
    mask: &HashSet<(i32, i32)>,
    threshold_num: usize,
    threshold_den: usize,
) -> HashSet<(i32, i32)> {
    if mask.is_empty() {
        return HashSet::new();
    }
    let (min_x, max_x, min_z, max_z) = bounds_of_set(mask);
    let mut out = HashSet::new();
    for z in (min_z - 1)..=(max_z + 1) {
        for x in (min_x - 1)..=(max_x + 1) {
            let mut cnt = 0usize;
            for dz in -1..=1 {
                for dx in -1..=1 {
                    if mask.contains(&(x + dx, z + dz)) {
                        cnt += 1;
                    }
                }
            }
            if cnt * threshold_den >= threshold_num * 9 {
                out.insert((x, z));
            }
        }
    }
    out
}

fn bounds_of_set(mask: &HashSet<(i32, i32)>) -> (i32, i32, i32, i32) {
    let mut min_x = i32::MAX;
    let mut max_x = i32::MIN;
    let mut min_z = i32::MAX;
    let mut max_z = i32::MIN;
    for &(x, z) in mask {
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_z = min_z.min(z);
        max_z = max_z.max(z);
    }
    (min_x, max_x, min_z, max_z)
}

fn estimate_ground_for_post(
    cell: (i32, i32),
    walkable: &HashMap<(i32, i32), f32>,
    blocked: &HashMap<(i32, i32), f32>,
    state: &HashMap<(i32, i32), CellState>,
) -> Option<f32> {
    let mut hs = Vec::new();
    for dz in -1..=1 {
        for dx in -1..=1 {
            if dx == 0 && dz == 0 {
                continue;
            }
            let n = (cell.0 + dx, cell.1 + dz);
            if let Some(&h) = walkable.get(&n) {
                hs.push(h);
                continue;
            }
            if let Some(s) = state.get(&n) {
                if let Some(h) = s.ground_y {
                    hs.push(h);
                    continue;
                }
            }
            if let Some(&h) = blocked.get(&n) {
                hs.push(h);
            }
        }
    }
    if hs.is_empty() {
        return None;
    }
    hs.sort_by(f32::total_cmp);
    Some(hs[hs.len() / 2])
}

fn local_height_band_pass(
    cell: (i32, i32),
    ground: f32,
    walkable: &HashMap<(i32, i32), f32>,
    p: ParamSet,
) -> bool {
    let Some((low, high)) = local_height_band(cell, walkable, p) else {
        return false;
    };
    ground >= low && ground <= high
}

fn local_height_band(
    cell: (i32, i32),
    walkable: &HashMap<(i32, i32), f32>,
    p: ParamSet,
) -> Option<(f32, f32)> {
    let mut min_h = f32::INFINITY;
    let mut max_h = f32::NEG_INFINITY;
    for dz in -MAX_PATH_DIST..=MAX_PATH_DIST {
        for dx in -MAX_PATH_DIST..=MAX_PATH_DIST {
            let d = dx.abs() + dz.abs();
            if d == 0 || d > MAX_PATH_DIST {
                continue;
            }
            let n = (cell.0 + dx, cell.1 + dz);
            if let Some(&h) = walkable.get(&n) {
                min_h = min_h.min(h);
                max_h = max_h.max(h);
            }
        }
    }
    if !min_h.is_finite() || !max_h.is_finite() {
        return None;
    }
    Some((min_h - p.local_band_pad_down, max_h + p.local_band_pad_up))
}

fn has_support_path(
    cell: (i32, i32),
    ground: f32,
    walkable: &HashMap<(i32, i32), f32>,
    p: ParamSet,
) -> bool {
    for dz in -MAX_PATH_DIST..=MAX_PATH_DIST {
        for dx in -MAX_PATH_DIST..=MAX_PATH_DIST {
            let d = dx.abs() + dz.abs();
            if d == 0 || d > MAX_PATH_DIST {
                continue;
            }
            let Some(limit) = max_dh_by_manhattan(d, p) else {
                continue;
            };
            let n = (cell.0 + dx, cell.1 + dz);
            let Some(&h) = walkable.get(&n) else {
                continue;
            };
            if (h - ground).abs() <= limit {
                return true;
            }
        }
    }
    false
}

fn max_dh_by_manhattan(d: i32, p: ParamSet) -> Option<f32> {
    match d {
        1 => Some(p.dh_dist1_max),
        2 => Some(p.dh_dist2_max),
        3 => Some(p.dh_dist3_max),
        4 => Some(p.dh_dist4_max),
        _ => None,
    }
}

fn capsule_check_detail(
    cell: (i32, i32),
    ground: f32,
    obs: &HashMap<(i32, i32), ObsCell>,
    p: ParamSet,
) -> Option<CapsuleFailDetail> {
    let r = (CAPSULE_RADIUS_WORLD / GRID_RES_WORLD).ceil() as i32;
    let mut sample = 0u32;
    let mut occupied = 0u32;
    let mut body_points_total = 0u32;
    let mut center_upper_hits = 0u32;
    let low = ground + CAPSULE_HEIGHT_OFFSET;
    let high = ground + CAPSULE_HEIGHT_WORLD;
    let (cx, cz) = cell_center_world(cell);
    let in_debug_aabb = point_in_aabb(cx, cz);
    for dz in -r..=r {
        for dx in -r..=r {
            let dist = ((dx * dx + dz * dz) as f32).sqrt() * GRID_RES_WORLD;
            if dist > CAPSULE_RADIUS_WORLD + GRID_RES_WORLD * 0.5 {
                continue;
            }
            let Some(n) = obs.get(&(cell.0 + dx, cell.1 + dz)) else { continue };
            let body_points = n.ys.iter().filter(|&&y| y >= low && y <= high).count() as u32;
            if body_points == 0 {
                continue;
            }
            body_points_total += body_points;
            sample += 1;
            occupied += 1;
            if dist <= CAPSULE_CENTER_RADIUS_WORLD {
                let upper_body_points =
                    n.ys
                        .iter()
                        .filter(|&&y| y >= ground + CAPSULE_CENTER_UPPER_FLOOR && y <= high)
                        .count() as u32;
                center_upper_hits += upper_body_points;
                let center_upper_req = if in_debug_aabb && sample <= 2 {
                    CAPSULE_CENTER_UPPER_MIN_POINTS + 2
                } else if in_debug_aabb {
                    CAPSULE_CENTER_UPPER_MIN_POINTS + 1
                } else {
                    CAPSULE_CENTER_UPPER_MIN_POINTS
                };
                if upper_body_points >= center_upper_req {
                    let occ_ratio = occupied as f32 / sample.max(1) as f32;
                    let occ_points_ratio = body_points_total as f32
                        / (sample.max(1) as f32 * CAPSULE_OCC_POINTS_PER_CELL_NORM);
                    return Some(CapsuleFailDetail {
                        kind: CapsuleFailKind::CenterUpper,
                        sample_cells: sample,
                        occupied_cells: occupied,
                        occ_ratio,
                        center_upper_hits,
                        body_points_total,
                        occ_points_ratio,
                        low,
                        high,
                    });
                }
            }
        }
    }
    if sample == 0 {
        return None;
    }
    if sample < CAPSULE_MIN_SAMPLE_CELLS_FOR_OCC {
        return None;
    }
    let occ_ratio = occupied as f32 / sample as f32;
    let occ_points_ratio =
        body_points_total as f32 / (sample as f32 * CAPSULE_OCC_POINTS_PER_CELL_NORM);
    if occ_points_ratio > p.capsule_occ_max {
        return Some(CapsuleFailDetail {
            kind: CapsuleFailKind::OccRatio,
            sample_cells: sample,
            occupied_cells: occupied,
            occ_ratio,
            center_upper_hits,
            body_points_total,
            occ_points_ratio,
            low,
            high,
        });
    }
    None
}

fn has_unknown_neighbor(
    cell: (i32, i32),
    walkable: &HashMap<(i32, i32), f32>,
    blocked: &HashMap<(i32, i32), f32>,
) -> bool {
    for n in neighbors4(cell) {
        if !walkable.contains_key(&n) && !blocked.contains_key(&n) {
            return true;
        }
    }
    false
}

fn has_unknown_neighbor_set(
    cell: (i32, i32),
    walkable: &HashSet<(i32, i32)>,
    blocked: &HashSet<(i32, i32)>,
) -> bool {
    for n in neighbors4(cell) {
        if !walkable.contains(&n) && !blocked.contains(&n) {
            return true;
        }
    }
    false
}

fn neighbors4(cell: (i32, i32)) -> [(i32, i32); 4] {
    [(cell.0 + 1, cell.1), (cell.0 - 1, cell.1), (cell.0, cell.1 + 1), (cell.0, cell.1 - 1)]
}

fn world_to_cell(x: f32, z: f32) -> (i32, i32) {
    ((x / GRID_RES_WORLD).floor() as i32, (z / GRID_RES_WORLD).floor() as i32)
}

fn centroid_cell<I>(cells: I) -> (i32, i32)
where
    I: IntoIterator<Item = (i32, i32)>,
{
    let mut sx = 0f64;
    let mut sz = 0f64;
    let mut n = 0f64;
    for (x, z) in cells {
        sx += x as f64;
        sz += z as f64;
        n += 1.0;
    }
    if n <= 0.0 {
        (0, 0)
    } else {
        ((sx / n).round() as i32, (sz / n).round() as i32)
    }
}

fn dist_cells(a: (i32, i32), b: (i32, i32)) -> f32 {
    let dx = (a.0 - b.0) as f32;
    let dz = (a.1 - b.1) as f32;
    (dx * dx + dz * dz).sqrt()
}

#[derive(Clone, Copy)]
struct CameraBasis {
    right: [f64; 3],
    up_ortho: [f64; 3],
    dir: [f64; 3],
    pos: [f64; 3],
}

fn build_observation_grid_from_capture(
    capture: &crate::common::CaptureData,
) -> HashMap<(i32, i32), ObsCell> {
    let mut out = HashMap::<(i32, i32), ObsCell>::new();
    let basis = build_camera_basis(capture);
    let w = capture.width as i32;
    let h = capture.height as i32;
    let aspect = capture.width as f64 / capture.height as f64;
    let tan_half_fovy = (capture.fov_y_rad as f64 * 0.5).tan();
    let tan_half_fovx = tan_half_fovy * aspect;
    for y in 0..h {
        for x in 0..w {
            let idx = (y as usize) * capture.width + x as usize;
            let d = capture.depth[idx];
            if !d.is_finite() {
                continue;
            }
            let depth01 = d.clamp(0.0, 1.0);
            let z = linearize_depth(depth01, capture.near, capture.far) as f64;
            if !(z > capture.near as f64 && z < capture.far as f64) {
                continue;
            }
            let nx = ((x as f64 + 0.5) / capture.width as f64) * 2.0 - 1.0;
            let ny = 1.0 - ((y as f64 + 0.5) / capture.height as f64) * 2.0;
            let px = nx * tan_half_fovx * z;
            let py = ny * tan_half_fovy * z;
            let pz = z;
            let [wx, wy, wz_raw] = camera_to_world_fast_f64([px, py, pz], &basis);
            let wz = -wz_raw as f32;
            let ix = (wx as f32 / GRID_RES_WORLD).floor() as i32;
            let iz = (wz / GRID_RES_WORLD).floor() as i32;
            out.entry((ix, iz))
                .and_modify(|c| c.add(wy as f32))
                .or_insert_with(|| ObsCell::new(wy as f32));
        }
    }
    out
}

fn build_camera_basis(capture: &crate::common::CaptureData) -> CameraBasis {
    let up = normalize3_f64([
        capture.camera_up[0] as f64,
        capture.camera_up[1] as f64,
        capture.camera_up[2] as f64,
    ]);
    let dir = normalize3_f64([
        capture.camera_dir[0] as f64,
        capture.camera_dir[1] as f64,
        capture.camera_dir[2] as f64,
    ]);
    let right = normalize3_f64(cross_f64(up, dir));
    let up_ortho = normalize3_f64(cross_f64(dir, right));
    CameraBasis {
        right,
        up_ortho,
        dir,
        pos: [
            capture.camera_position[0] as f64,
            capture.camera_position[1] as f64,
            capture.camera_position[2] as f64,
        ],
    }
}

fn camera_to_world_fast_f64(p_camera: [f64; 3], basis: &CameraBasis) -> [f64; 3] {
    let [vx, vy, vz] = p_camera;
    [
        basis.pos[0] + basis.right[0] * vx + basis.up_ortho[0] * vy + basis.dir[0] * vz,
        basis.pos[1] + basis.right[1] * vx + basis.up_ortho[1] * vy + basis.dir[1] * vz,
        basis.pos[2] + basis.right[2] * vx + basis.up_ortho[2] * vy + basis.dir[2] * vz,
    ]
}

fn cross_f64(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn normalize3_f64(v: [f64; 3]) -> [f64; 3] {
    let n2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if n2 <= 1.0e-24 {
        return [0.0, 0.0, 0.0];
    }
    let inv = n2.sqrt().recip();
    [v[0] * inv, v[1] * inv, v[2] * inv]
}

fn classify_label(cell: (i32, i32), traj: &TrajectoryMask) -> LabelClass {
    let x = (cell.0 as f32 + 0.5) * GRID_RES_WORLD;
    let z = (cell.1 as f32 + 0.5) * GRID_RES_WORLD;
    if point_in_polygon(x, z, &traj.poly) {
        return LabelClass::Pos;
    }
    let d = distance_to_poly_edges(x, z, &traj.poly);
    if d >= NEG_RING_DIST_WORLD {
        LabelClass::Neg
    } else {
        LabelClass::Ignore
    }
}

fn distance_to_poly_edges(x: f32, z: f32, poly: &[[f32; 2]]) -> f32 {
    let mut best = f32::INFINITY;
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        let d2 = dist2_point_seg(x, z, a[0], a[1], b[0], b[1]);
        best = best.min(d2);
    }
    best.sqrt()
}

fn load_trajectory_mask(path: &Path) -> Result<TrajectoryMask> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).context("parse trajectory json")?;
    let coord_space = v.get("coord_space").and_then(|x| x.as_str()).unwrap_or("game");
    let src_space = parse_coord_space(coord_space);
    let loops = v.get("loops").and_then(|x| x.as_array()).context("trajectory missing loops")?;
    let first_loop = loops.first().and_then(|x| x.as_array()).context("trajectory loops empty")?;
    let mut poly = Vec::with_capacity(first_loop.len());
    for p in first_loop {
        let arr = p.as_array().context("loop point not array")?;
        if arr.len() != 3 {
            continue;
        }
        let x = arr[0].as_f64().unwrap_or(0.0) as f32;
        let _y = arr[1].as_f64().unwrap_or(0.0) as f32;
        let z = arr[2].as_f64().unwrap_or(0.0) as f32;
        let zg = convert_z(z, src_space, CoordSpace::Game);
        poly.push([x, -zg]);
    }
    if poly.len() < 3 {
        anyhow::bail!("trajectory polygon has fewer than 3 points");
    }
    Ok(TrajectoryMask { poly })
}
