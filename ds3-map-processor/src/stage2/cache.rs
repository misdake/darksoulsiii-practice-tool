use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};

use anyhow::Result;

use crate::common::{CaptureData, CAPTURE_CACHE_BYTES};
use crate::stage1_pointcloud::load_capture_from_toml;

#[derive(Clone)]
pub(super) struct CachedCapture {
    pub(super) data: Arc<CaptureData>,
    pub(super) bytes: usize,
    pub(super) last_used_tick: u64,
}

pub(super) struct LoadSlot {
    pub(super) result: Mutex<Option<Result<Arc<CaptureData>, String>>>,
    pub(super) ready: Condvar,
}

pub(super) struct CaptureLru {
    pub(super) budget_bytes: usize,
    pub(super) used_bytes: usize,
    pub(super) peak_used_bytes: usize,
    pub(super) tick: u64,
    pub(super) map: HashMap<String, CachedCapture>,
    pub(super) inflight: HashMap<String, Arc<LoadSlot>>,
}

pub(super) fn new_capture_lru() -> CaptureLru {
    CaptureLru {
        budget_bytes: CAPTURE_CACHE_BYTES,
        used_bytes: 0,
        peak_used_bytes: 0,
        tick: 0,
        map: HashMap::new(),
        inflight: HashMap::new(),
    }
}

pub(super) fn capture_data_bytes(c: &CaptureData) -> usize {
    c.rgb.as_raw().len().saturating_add(c.depth.len().saturating_mul(4))
}

pub(super) fn get_or_load_capture(
    cache: &Arc<Mutex<CaptureLru>>,
    toml_path: &str,
) -> Result<Arc<CaptureData>> {
    let maybe_wait_slot = {
        let mut guard = cache.lock().expect("capture_cache poisoned");
        let tick = guard.tick.saturating_add(1);
        guard.tick = tick;
        if let Some(e) = guard.map.get_mut(toml_path) {
            e.last_used_tick = tick;
            return Ok(Arc::clone(&e.data));
        }
        if let Some(slot) = guard.inflight.get(toml_path) {
            Some(Arc::clone(slot))
        } else {
            let slot = Arc::new(LoadSlot { result: Mutex::new(None), ready: Condvar::new() });
            guard.inflight.insert(toml_path.to_string(), Arc::clone(&slot));
            None
        }
    };

    if let Some(slot) = maybe_wait_slot {
        let mut state = slot.result.lock().expect("load slot poisoned");
        while state.is_none() {
            state = slot.ready.wait(state).expect("load slot wait poisoned");
        }
        return match state.as_ref().expect("result just checked") {
            Ok(data) => Ok(Arc::clone(data)),
            Err(msg) => anyhow::bail!(msg.clone()),
        };
    }

    let loaded_res: Result<Arc<CaptureData>, String> =
        load_capture_from_toml(Path::new(toml_path)).map(Arc::new).map_err(|e| e.to_string());

    let mut guard = cache.lock().expect("capture_cache poisoned");
    let slot = guard.inflight.remove(toml_path).expect("inflight slot missing for leader");

    let result_to_publish = match loaded_res {
        Ok(loaded) => {
            let loaded_bytes = capture_data_bytes(&loaded);
            let tick = guard.tick.saturating_add(1);
            guard.tick = tick;
            if let Some(e) = guard.map.get_mut(toml_path) {
                e.last_used_tick = tick;
                Ok(Arc::clone(&e.data))
            } else {
                guard.used_bytes = guard.used_bytes.saturating_add(loaded_bytes);
                guard.peak_used_bytes = guard.peak_used_bytes.max(guard.used_bytes);
                guard.map.insert(
                    toml_path.to_string(),
                    CachedCapture {
                        data: Arc::clone(&loaded),
                        bytes: loaded_bytes,
                        last_used_tick: tick,
                    },
                );
                while guard.used_bytes > guard.budget_bytes {
                    let mut oldest_key: Option<String> = None;
                    let mut oldest_tick = u64::MAX;
                    for (k, v) in &guard.map {
                        if v.last_used_tick < oldest_tick {
                            oldest_tick = v.last_used_tick;
                            oldest_key = Some(k.clone());
                        }
                    }
                    let Some(k) = oldest_key else { break };
                    if let Some(removed) = guard.map.remove(&k) {
                        guard.used_bytes = guard.used_bytes.saturating_sub(removed.bytes);
                    } else {
                        break;
                    }
                }
                Ok(loaded)
            }
        }
        Err(msg) => Err(msg),
    };

    {
        let mut state = slot.result.lock().expect("load slot poisoned");
        *state = Some(result_to_publish.clone());
    }
    slot.ready.notify_all();

    match result_to_publish {
        Ok(data) => Ok(data),
        Err(msg) => anyhow::bail!(msg),
    }
}
