use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use hudhook::tracing::{debug, warn};
use hudhook::RenderContext;
use image::EncodableLayout;
use imgui::TextureId;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct TileIndex {
    pub tile_size_px: u32,
    pub image_ext: String,
    pub scales_world_units_per_pixel: Vec<f32>,
    pub levels: BTreeMap<String, LevelIndex>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LevelIndex {
    pub tile_world_size: f32,
    pub x: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub struct TileKey {
    pub z: i32,
    pub tx: i32,
    pub ty: i32,
}

#[derive(Debug, Clone)]
struct TextureSlot {
    texture_id: TextureId,
    key: TileKey,
    last_used_frame: u64,
}

pub struct TileManager {
    root: PathBuf,
    index: Option<TileIndex>,
    index_load_attempted: bool,
    slots: Vec<TextureSlot>,
    by_key: HashMap<TileKey, usize>,
    frame_no: u64,
    max_slots: usize,
    uploads_per_frame: usize,
}

impl TileManager {
    pub fn new(root: impl Into<PathBuf>, max_slots: usize, uploads_per_frame: usize) -> Self {
        Self {
            root: root.into(),
            index: None,
            index_load_attempted: false,
            slots: Vec::new(),
            by_key: HashMap::new(),
            frame_no: 0,
            max_slots,
            uploads_per_frame,
        }
    }

    pub fn set_root(&mut self, root: impl Into<PathBuf>) {
        let root = root.into();
        if self.root != root {
            self.root = root;
            self.index = None;
            self.index_load_attempted = false;
            self.by_key.clear();
            self.slots.clear();
        }
    }

    pub fn begin_frame(&mut self) {
        self.frame_no = self.frame_no.wrapping_add(1);
    }

    pub fn index(&mut self) -> Option<&TileIndex> {
        if self.index.is_none() && !self.index_load_attempted {
            self.index_load_attempted = true;
            let path = self.root.join("index.json");
            match std::fs::read_to_string(&path) {
                Ok(s) => match serde_json::from_str::<TileIndex>(&s) {
                    Ok(idx) => self.index = Some(idx),
                    Err(e) => warn!("bad tile index {}: {}", path.display(), e),
                },
                Err(e) => warn!("tile index missing {}: {}", path.display(), e),
            }
        }
        self.index.as_ref()
    }

    pub fn pick_level_auto(&self, target_world_units_per_px: f32) -> Option<i32> {
        let idx = self.index.as_ref()?;
        let mut best: Option<(i32, f32)> = None;
        for z_name in idx.levels.keys() {
            let Ok(z) = z_name.parse::<i32>() else { continue };
            let Some(s) = idx.scales_world_units_per_pixel.get(z as usize).copied() else {
                continue;
            };
            if s <= 0.0 || target_world_units_per_px <= 0.0 {
                continue;
            }
            let err = (target_world_units_per_px / s).log2().abs();
            match best {
                None => best = Some((z, err)),
                Some((_, best_err)) if err < best_err => best = Some((z, err)),
                _ => {},
            }
        }
        best.map(|x| x.0)
    }

    pub fn level_tile_world_size(&self, z: i32) -> Option<f32> {
        self.index.as_ref()?.levels.get(&z.to_string()).map(|x| x.tile_world_size)
    }

    pub fn tile_size_px(&self) -> Option<u32> {
        self.index.as_ref().map(|x| x.tile_size_px)
    }

    pub fn has_tile(&self, key: TileKey) -> bool {
        let Some(idx) = self.index.as_ref() else { return false };
        let Some(level) = idx.levels.get(&key.z.to_string()) else { return false };
        let Some(ys) = level.x.get(&key.tx.to_string()) else { return false };
        ys.iter().any(|y| y == &key.ty.to_string())
    }

    pub fn prepare_needed(&mut self, render: &mut dyn RenderContext, wanted: &[TileKey]) {
        let wanted_set: HashSet<TileKey> = wanted.iter().copied().collect();
        for key in wanted {
            if let Some(&slot_idx) = self.by_key.get(key) {
                self.slots[slot_idx].last_used_frame = self.frame_no;
            }
        }

        let mut uploaded = 0usize;
        for key in wanted.iter().copied() {
            if self.by_key.contains_key(&key) {
                continue;
            }
            if uploaded >= self.uploads_per_frame {
                break;
            }
            if !self.has_tile(key) {
                continue;
            }
            if self.upload_tile(render, key, &wanted_set) {
                uploaded += 1;
            }
        }
    }

    pub fn texture_for(&mut self, key: TileKey) -> Option<TextureId> {
        let &slot_idx = self.by_key.get(&key)?;
        let slot = self.slots.get_mut(slot_idx)?;
        slot.last_used_frame = self.frame_no;
        Some(slot.texture_id)
    }

    fn upload_tile(
        &mut self,
        render: &mut dyn RenderContext,
        key: TileKey,
        wanted_set: &HashSet<TileKey>,
    ) -> bool {
        let path = self.tile_path(key);
        let Ok(img) = image::open(&path).map(|x| x.into_rgba8()) else {
            return false;
        };
        let bytes = img.as_bytes();
        let (w, h) = (img.width(), img.height());

        if self.slots.len() < self.max_slots {
            let Ok(texture_id) = render.load_texture(bytes, w, h) else {
                return false;
            };
            let slot_idx = self.slots.len();
            self.slots.push(TextureSlot { texture_id, key, last_used_frame: self.frame_no });
            self.by_key.insert(key, slot_idx);
            return true;
        }

        let Some((evict_idx, _)) = self
            .slots
            .iter()
            .enumerate()
            .filter(|(_, s)| !wanted_set.contains(&s.key))
            .min_by_key(|(_, s)| s.last_used_frame)
        else {
            return false;
        };

        let old_key = self.slots[evict_idx].key;
        let texture_id = self.slots[evict_idx].texture_id;
        if render.replace_texture(texture_id, bytes, w, h).is_err() {
            return false;
        }
        self.slots[evict_idx].key = key;
        self.slots[evict_idx].last_used_frame = self.frame_no;
        self.by_key.remove(&old_key);
        self.by_key.insert(key, evict_idx);
        debug!("tile texture recycled {:?} -> {:?}", old_key, key);
        true
    }

    fn tile_path(&self, key: TileKey) -> PathBuf {
        let ext = self
            .index
            .as_ref()
            .map(|x| x.image_ext.as_str())
            .filter(|x| !x.is_empty())
            .unwrap_or("png");
        self.root
            .join(key.z.to_string())
            .join(key.tx.to_string())
            .join(format!("{}.{}", key.ty, ext))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}
