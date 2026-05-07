mod common;
mod fs_utils;
mod stage1_pointcloud;
mod stage2_tile_pipeline;

use anyhow::{Context, Result};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use crate::common::{CaptureToml, MAX_POINT_BYTES_IN_FLIGHT};
use crate::fs_utils::{
    clear_directory, ensure_workdir_layout, find_all_toml_in_capture, find_repo_root,
};
use crate::stage1_pointcloud::split_capture_to_tile_points;
use crate::stage2_tile_pipeline::render_tiles_to_pyramid;

fn main() -> Result<()> {
    let total_start = Instant::now();
    let repo_root = find_repo_root()?;
    let capture_dir = repo_root.join("capture");
    let work_dir = repo_root.join("map-work");
    ensure_workdir_layout(&work_dir)?;

    let selected = find_all_toml_in_capture(&capture_dir)?;
    println!("Stage 1/2 capture->tile-points: {} capture(s).", selected.len());
    let stage1_start = Instant::now();
    let tile_points_root = work_dir.join("tile-points");
    fs::create_dir_all(&tile_points_root)
        .with_context(|| format!("mkdir {}", tile_points_root.display()))?;
    clear_directory(&tile_points_root)?;

    run_with_budget(selected, |toml_path| estimate_capture_bytes(toml_path).unwrap_or(1), {
        let tile_points_root = tile_points_root.clone();
        move |toml_path, reserved_bytes| {
            let written_points = split_capture_to_tile_points(&toml_path, &tile_points_root)?;
            println!(
                "  split {} -> {} point(s), in_flight={}MB",
                toml_path.display(),
                written_points,
                reserved_bytes / (1024 * 1024)
            );
            Ok(())
        }
    })?;
    println!("Stage 1/2 done in {:.3}s", stage1_start.elapsed().as_secs_f64());

    println!("Stage 2/2 tile-points->tile pyramid.");
    let stage2_start = Instant::now();
    let tiles_root = work_dir.join("tiles");
    fs::create_dir_all(&tiles_root).with_context(|| format!("mkdir {}", tiles_root.display()))?;
    clear_directory(&tiles_root)?;
    let alerts_path = work_dir.join("alerts.csv");
    let index_path = tiles_root.join("index.json");
    render_tiles_to_pyramid(
        &capture_dir,
        &tile_points_root,
        &tiles_root,
        &alerts_path,
        &index_path,
    )?;
    println!("Stage 2/2 done in {:.3}s", stage2_start.elapsed().as_secs_f64());

    println!(
        "Done in {:.3}s. output root: {}",
        total_start.elapsed().as_secs_f64(),
        work_dir.display()
    );
    Ok(())
}

fn estimate_capture_bytes(toml_path: &Path) -> Result<usize> {
    let content =
        fs::read_to_string(toml_path).with_context(|| format!("read {}", toml_path.display()))?;
    let meta: CaptureToml = toml::from_str(&content).context("parse capture toml")?;
    let base_dir = toml_path.parent().context("toml has no parent directory")?;
    let rgb_size =
        fs::metadata(base_dir.join(meta.rgb_file)).map(|m| m.len() as usize).unwrap_or(0);
    let exr_size =
        fs::metadata(base_dir.join(meta.depth_file)).map(|m| m.len() as usize).unwrap_or(0);
    Ok((rgb_size + exr_size).max(1))
}

fn run_with_budget<T, FEst, FJob>(tasks: Vec<T>, estimate: FEst, job: FJob) -> Result<()>
where
    T: Send + Sync + Clone + 'static,
    FEst: Fn(&T) -> usize + Send + Sync + 'static,
    FJob: Fn(T, usize) -> Result<()> + Send + Sync + 'static,
{
    let max_workers = std::thread::available_parallelism().map_or(1usize, |n| n.get().max(1));
    let budget = MAX_POINT_BYTES_IN_FLIGHT;

    let tasks = Arc::new(tasks);
    let estimate = Arc::new(estimate);
    let job = Arc::new(job);

    let next = Arc::new(AtomicUsize::new(0));
    let inflight = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let first_err: Arc<Mutex<Option<anyhow::Error>>> = Arc::new(Mutex::new(None));

    let mut handles = Vec::with_capacity(max_workers);
    for _ in 0..max_workers {
        let tasks = Arc::clone(&tasks);
        let estimate = Arc::clone(&estimate);
        let job = Arc::clone(&job);
        let next = Arc::clone(&next);
        let inflight = Arc::clone(&inflight);
        let failed = Arc::clone(&failed);
        let first_err = Arc::clone(&first_err);

        handles.push(thread::spawn(move || loop {
            if failed.load(Ordering::SeqCst) {
                break;
            }

            let idx = next.fetch_add(1, Ordering::SeqCst);
            if idx >= tasks.len() {
                break;
            }
            let task = tasks[idx].clone();
            let est = estimate(&task).max(1);
            let reserve = est.min(budget.max(1));

            loop {
                if failed.load(Ordering::SeqCst) {
                    return;
                }
                let cur = inflight.load(Ordering::SeqCst);
                if (cur == 0 || cur.saturating_add(reserve) <= budget)
                    && inflight
                        .compare_exchange(
                            cur,
                            cur.saturating_add(reserve),
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        )
                        .is_ok()
                {
                    break;
                }
                thread::sleep(std::time::Duration::from_millis(2));
            }

            let result = job(task, inflight.load(Ordering::SeqCst));
            inflight.fetch_sub(reserve, Ordering::SeqCst);

            if let Err(err) = result {
                failed.store(true, Ordering::SeqCst);
                let mut slot = first_err.lock().expect("first_err poisoned");
                if slot.is_none() {
                    *slot = Some(err);
                }
                return;
            }
        }));
    }

    for handle in handles {
        let _ = handle.join();
    }

    if let Some(err) = first_err.lock().expect("first_err poisoned").take() {
        return Err(err);
    }

    Ok(())
}
