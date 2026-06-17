use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::Result;

pub fn run_with_budget<T, FEst, FJob>(
    tasks: Vec<T>,
    estimate: FEst,
    budget: usize,
    max_workers: usize,
    job: FJob,
) -> Result<usize>
where
    T: Send + Sync + Clone + 'static,
    FEst: Fn(&T) -> usize + Send + Sync + 'static,
    // job receives (task, reserved_bytes_for_this_task)
    FJob: Fn(T, usize) -> Result<()> + Send + Sync + 'static,
{
    let workers = max_workers.max(1);
    let budget = budget.max(1);

    let tasks = Arc::new(tasks);
    let estimate = Arc::new(estimate);
    let job = Arc::new(job);

    let next = Arc::new(AtomicUsize::new(0));
    let inflight = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let max_inflight = Arc::new(AtomicUsize::new(0));
    let first_err: Arc<Mutex<Option<anyhow::Error>>> = Arc::new(Mutex::new(None));

    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let tasks = Arc::clone(&tasks);
        let estimate = Arc::clone(&estimate);
        let job = Arc::clone(&job);
        let next = Arc::clone(&next);
        let inflight = Arc::clone(&inflight);
        let failed = Arc::clone(&failed);
        let first_err = Arc::clone(&first_err);
        let max_inflight = Arc::clone(&max_inflight);

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
            let reserve = est.min(budget);

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
                    let now = cur.saturating_add(reserve);
                    loop {
                        let prev = max_inflight.load(Ordering::SeqCst);
                        if now <= prev {
                            break;
                        }
                        if max_inflight
                            .compare_exchange(prev, now, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            break;
                        }
                    }
                    break;
                }
                thread::sleep(std::time::Duration::from_millis(2));
            }

            let result = job(task, reserve);
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

    Ok(max_inflight.load(Ordering::SeqCst))
}
