use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) static PROF_GET_OR_LOAD_NS: AtomicUsize = AtomicUsize::new(0);
pub(super) static PROF_ITER_POINTS_NS: AtomicUsize = AtomicUsize::new(0);
pub(super) static PROF_ACCUM_NS: AtomicUsize = AtomicUsize::new(0);
pub(super) static PROF_RENDER_NS: AtomicUsize = AtomicUsize::new(0);
pub(super) static PROF_MASK_NS: AtomicUsize = AtomicUsize::new(0);
pub(super) static PROF_JPEG_NS: AtomicUsize = AtomicUsize::new(0);
pub(super) static PROF_REF_COUNT: AtomicUsize = AtomicUsize::new(0);
pub(super) static PROF_TILE_COUNT: AtomicUsize = AtomicUsize::new(0);

#[inline]
pub(super) fn reset_stage2_profile_counters() {
    PROF_GET_OR_LOAD_NS.store(0, Ordering::Relaxed);
    PROF_ITER_POINTS_NS.store(0, Ordering::Relaxed);
    PROF_ACCUM_NS.store(0, Ordering::Relaxed);
    PROF_RENDER_NS.store(0, Ordering::Relaxed);
    PROF_MASK_NS.store(0, Ordering::Relaxed);
    PROF_JPEG_NS.store(0, Ordering::Relaxed);
    PROF_REF_COUNT.store(0, Ordering::Relaxed);
    PROF_TILE_COUNT.store(0, Ordering::Relaxed);
}

#[inline]
pub(super) fn add_prof_ns(counter: &AtomicUsize, ns: u128) {
    counter.fetch_add((ns.min(usize::MAX as u128)) as usize, Ordering::Relaxed);
}

pub(super) fn print_stage2_profile_summary() {
    let to_ms = |ns: usize| (ns as f64) / 1_000_000.0;
    let refs = PROF_REF_COUNT.load(Ordering::Relaxed);
    let tiles = PROF_TILE_COUNT.load(Ordering::Relaxed);
    println!("Stage2 profile (aggregated across threads):");
    println!("  refs={} tiles={}", refs, tiles);
    println!("  get_or_load_capture: {:.3} ms", to_ms(PROF_GET_OR_LOAD_NS.load(Ordering::Relaxed)));
    println!(
        "  iter_points_in_aabb_for_tile: {:.3} ms",
        to_ms(PROF_ITER_POINTS_NS.load(Ordering::Relaxed))
    );
    println!(
        "  accumulate_points_for_tile: {:.3} ms",
        to_ms(PROF_ACCUM_NS.load(Ordering::Relaxed))
    );
    println!("  render_tile_from_accum: {:.3} ms", to_ms(PROF_RENDER_NS.load(Ordering::Relaxed)));
    println!("  apply_walkable_mask: {:.3} ms", to_ms(PROF_MASK_NS.load(Ordering::Relaxed)));
    println!("  save_jpeg: {:.3} ms", to_ms(PROF_JPEG_NS.load(Ordering::Relaxed)));
}
