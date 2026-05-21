mod camera_info;
mod geometry;
pub mod overlay;
mod texture;
mod tile;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use geometry::{ClipMode, MapViewParams, Visibility};
use hudhook::tracing::{info, warn};
use hudhook::RenderContext;
use imgui::{Condition, Context, ImColor32, WindowFlags};
use libds3::pointers::PointerChains;
use serde::Deserialize;
use tile::{TileKey, TileManager};

use crate::map::camera_info::CameraInfo;
use crate::map::texture::Texture;
use crate::util;

const REFERENCE_HEIGHT: f32 = 1080.0;
const RIGHT: f32 = 23.0;
const TOP: f32 = 30.0;
const MAP_SIZE: f32 = 192.0;
const MAP_HSIZE: f32 = MAP_SIZE * 0.5;
const CAMERA_FOV_SIZE_SCALE: f32 = 0.92;
const POINTER_WORLD_SIZE_WU: f32 = 1.5;
const CAMERA_FOV_WORLD_SIZE_WU: f32 = 5.5;
const TREASURE_MARKER_SIZE_WU: [f32; 2] = [1.5, 1.5];
const PLAYER_ARROW_PIVOT: [f32; 2] = overlay::PLAYER_ARROW_PIVOT;
const PANEL_BUTTON_OFFSET_X: f32 = 0.0;
const PANEL_BUTTON_OFFSET_Y: f32 = 8.0;
const PANEL_WINDOW_OFFSET_X: f32 = -4.0;
const PANEL_WINDOW_OFFSET_Y: f32 = 2.0;
pub(crate) const SIZE_SCALE_MIN: f32 = 0.5;
pub(crate) const SIZE_SCALE_MAX: f32 = 3.0;
pub(crate) const INDICATOR_SCALE_MIN: f32 = 0.25;
pub(crate) const INDICATOR_SCALE_MAX: f32 = 4.0;
const TREASURE_FILE_REL_PATH: &str = "map-work/treasures.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MapMode {
    SquareNorthUp,
    #[default]
    SquareRotateWithPlayer,
}

impl MapMode {
    pub fn as_clip_mode(self) -> ClipMode {
        let _ = self;
        ClipMode::SquareRotateWithPlayer
    }

    pub fn as_str(self) -> &'static str {
        match self {
            MapMode::SquareNorthUp => "square_north_up",
            MapMode::SquareRotateWithPlayer => "square_rotate_with_player",
        }
    }
}

pub struct MapViewer {
    pointer: Texture,
    camera_fov: Texture,
    marker_default: Texture,
    overlay_icons: HashMap<String, Texture>,
    camera_info: CameraInfo,
    tile_manager: TileManager,

    size_scale: f32,
    indicator_scale: f32,
    level: i32,
    mode: MapMode,
    z_flip: bool,

    player_dir: f32,
    camera_dir: f32,
    visible: bool,
    player_pos: Option<[f32; 3]>,
    status_text: String,
    wanted_next_frame: Vec<TileKey>,
    show_hardcoded_treasures: bool,
    treasure_points: Vec<TreasurePoint>,
    treasure_file_path: PathBuf,
    treasure_file_mtime: Option<SystemTime>,
    treasure_load_error_logged: bool,
}

pub struct ConfigPanelResult {
    pub changed: bool,
    pub eject_requested: bool,
    pub occupied_height: f32,
}

struct TileCollectInput<'a> {
    view: &'a MapViewParams,
    level: i32,
    tile_world_size: f32,
    target_wu_per_px: f32,
    content_hsize: f32,
    center_x: f32,
    center_z: f32,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TreasurePointRepr {
    Object { x: f32, z: f32, icon: Option<String> },
    Tuple([f32; 3]),
}

#[derive(Deserialize)]
struct TreasureFile {
    points: Vec<TreasurePointRepr>,
}

#[derive(Clone)]
struct TreasurePoint {
    x: f32,
    z: f32,
    icon: String,
}

impl MapViewer {
    fn texture_for_overlay_icon(&self, icon: &str) -> &Texture {
        self.overlay_icons.get(icon).unwrap_or(&self.marker_default)
    }

    fn enqueue_hardcoded_treasures(&self) {
        let marker_size_wu = [
            TREASURE_MARKER_SIZE_WU[0] * self.indicator_scale,
            TREASURE_MARKER_SIZE_WU[1] * self.indicator_scale,
        ];
        for p in &self.treasure_points {
            let world_z = if self.z_flip { -p.z } else { p.z };
            let world_xz = [p.x, world_z];
            overlay::add_icon(
                &p.icon,
                world_xz,
                marker_size_wu,
                overlay::MARKER_DEFAULT_PIVOT,
                [1.0, 1.0, 1.0, 1.0],
            );
        }
    }

    fn default_treasure_file_path() -> PathBuf {
        if let Ok(mut p) = std::env::current_exe() {
            p.pop();
            return p.join(TREASURE_FILE_REL_PATH);
        }
        if let Some(mut p) = util::get_dll_path() {
            p.pop();
            return p.join(TREASURE_FILE_REL_PATH);
        }
        PathBuf::from(TREASURE_FILE_REL_PATH)
    }

    fn refresh_treasures_if_needed(&mut self) {
        let meta = fs::metadata(&self.treasure_file_path);
        let Ok(meta) = meta else {
            self.treasure_points.clear();
            self.treasure_file_mtime = None;
            if !self.treasure_load_error_logged {
                util::append_log_line(&format!(
                    "treasure file missing: {}",
                    self.treasure_file_path.display()
                ));
                self.treasure_load_error_logged = true;
            }
            return;
        };

        let mtime = meta.modified().ok();
        if self.treasure_file_mtime.is_some() && self.treasure_file_mtime == mtime {
            return;
        }

        let content = match fs::read_to_string(&self.treasure_file_path) {
            Ok(s) => s,
            Err(e) => {
                self.treasure_points.clear();
                self.treasure_file_mtime = mtime;
                if !self.treasure_load_error_logged {
                    util::append_log_line(&format!(
                        "treasure file read error: {} ({})",
                        self.treasure_file_path.display(),
                        e
                    ));
                    self.treasure_load_error_logged = true;
                }
                return;
            },
        };

        let parsed = match serde_json::from_str::<TreasureFile>(&content) {
            Ok(v) => v,
            Err(e) => {
                self.treasure_points.clear();
                self.treasure_file_mtime = mtime;
                if !self.treasure_load_error_logged {
                    util::append_log_line(&format!(
                        "treasure file parse error: {} ({})",
                        self.treasure_file_path.display(),
                        e
                    ));
                    self.treasure_load_error_logged = true;
                }
                return;
            },
        };

        self.treasure_points = parsed
            .points
            .into_iter()
            .map(|p| match p {
                TreasurePointRepr::Object { x, z, icon } => TreasurePoint {
                    x,
                    z,
                    icon: icon.unwrap_or_else(|| "default".to_string()),
                },
                TreasurePointRepr::Tuple(v) => TreasurePoint {
                    x: v[0],
                    z: v[2],
                    icon: "default".to_string(),
                },
            })
            .collect();
        self.treasure_file_mtime = mtime;
        self.treasure_load_error_logged = false;
        util::append_log_line(&format!(
            "treasure file loaded: {} points={}",
            self.treasure_file_path.display(),
            self.treasure_points.len()
        ));
    }

    fn collect_wanted_tiles(&mut self, input: TileCollectInput<'_>) -> Vec<TileKey> {
        let query_half_extent_px = if matches!(self.mode, MapMode::SquareRotateWithPlayer) {
            input.content_hsize * std::f32::consts::SQRT_2
        } else {
            input.content_hsize
        };
        let min_x = input.center_x - query_half_extent_px * input.target_wu_per_px;
        let max_x = input.center_x + query_half_extent_px * input.target_wu_per_px;
        let min_z = input.center_z - query_half_extent_px * input.target_wu_per_px;
        let max_z = input.center_z + query_half_extent_px * input.target_wu_per_px;
        let tx0 = (min_x / input.tile_world_size).floor() as i32;
        let tx1 = (max_x / input.tile_world_size).ceil() as i32;
        let ty0 = (min_z / input.tile_world_size).floor() as i32;
        let ty1 = (max_z / input.tile_world_size).ceil() as i32;

        let mut wanted = Vec::new();
        for tx in tx0..=tx1 {
            for ty in ty0..=ty1 {
                let key = TileKey { z: input.level, tx, ty };
                if !self.tile_manager.has_tile(key) {
                    continue;
                }
                let world_aabb = [
                    tx as f32 * input.tile_world_size - input.target_wu_per_px * 0.5,
                    (tx + 1) as f32 * input.tile_world_size + input.target_wu_per_px * 0.5,
                    ty as f32 * input.tile_world_size - input.target_wu_per_px * 0.5,
                    (ty + 1) as f32 * input.tile_world_size + input.target_wu_per_px * 0.5,
                ];
                if !matches!(input.view.tile_visibility(world_aabb), Visibility::Hidden) {
                    wanted.push(key);
                }
            }
        }
        wanted
    }

    fn render_overlays(
        &self,
        ui: &imgui::Ui,
        draw_list: &imgui::DrawListMut<'_>,
        clip_min: [f32; 2],
        clip_max: [f32; 2],
        view: &MapViewParams,
        target_wu_per_px: f32,
    ) {
        draw_list.with_clip_rect(clip_min, clip_max, || {
            for item in overlay::take_frame_items() {
                match item {
                    overlay::OverlayItem::Icon {
                        icon,
                        world_xz,
                        size_wu,
                        pivot,
                        color: _,
                    } => {
                        let size_px = [
                            size_wu[0] / target_wu_per_px,
                            size_wu[1] / target_wu_per_px,
                        ];
                        if let Some(v) = view.marker_visibility(world_xz, size_px, pivot) {
                            self.texture_for_overlay_icon(&icon).render_rect(draw_list, v.screen_rect);
                        }
                    },
                    overlay::OverlayItem::Text { world_xz, text, color, size_wu, pivot } => {
                        let size_px = [
                            size_wu[0] / target_wu_per_px,
                            size_wu[1] / target_wu_per_px,
                        ];
                        if let Some(v) = view.marker_visibility(world_xz, size_px, pivot) {
                            draw_list.add_text(
                                [v.screen_rect[0], v.screen_rect[1]],
                                ImColor32::from_rgba_f32s(color[0], color[1], color[2], color[3]),
                                text,
                            );
                        }
                    },
                    overlay::OverlayItem::IconText {
                        icon,
                        world_xz,
                        text,
                        color: _,
                        icon_size_wu,
                        spacing_px,
                    } => {
                        let icon_size_px = [
                            icon_size_wu[0] / target_wu_per_px,
                            icon_size_wu[1] / target_wu_per_px,
                        ];
                        let text_size = ui.calc_text_size(&text);
                        let total_h = icon_size_px[1] + spacing_px + text_size[1];
                        if let Some(v) =
                            view.marker_visibility(world_xz, [icon_size_px[0], total_h], [0.5, 0.5])
                        {
                            let cx = v.screen_anchor[0];
                            let top = v.screen_anchor[1] - total_h * 0.5;
                            self.texture_for_overlay_icon(&icon).render_rect(
                                draw_list,
                                [
                                    cx - icon_size_px[0] * 0.5,
                                    top,
                                    cx + icon_size_px[0] * 0.5,
                                    top + icon_size_px[1],
                                ],
                            );
                            draw_list.add_text(
                                [cx - text_size[0] * 0.5, top + icon_size_px[1] + spacing_px],
                                ImColor32::from_rgba_f32s(1.0, 1.0, 1.0, 1.0),
                                text,
                            );
                        }
                    },
                }
            }
        });
    }

    pub fn new(pointers: &PointerChains) -> Self {
        let pointer = Texture::new(include_bytes!("icons/player_arrow.png"), None);
        let camera_fov = Texture::new(include_bytes!("icons/camera_fov_512.png"), None);
        let marker_default = Texture::new(include_bytes!("icons/marker_default.png"), None);
        let mut overlay_icons = HashMap::new();
        overlay_icons.insert(
            "default".to_string(),
            Texture::new(include_bytes!("icons/marker_default.png"), None),
        );
        overlay_icons.insert(
            "treasure".to_string(),
            Texture::new(include_bytes!("icons/marker_default.png"), None),
        );
        let camera_info = CameraInfo::new(pointers);

        MapViewer {
            pointer,
            camera_fov,
            marker_default,
            overlay_icons,
            camera_info,
            tile_manager: TileManager::new(PathBuf::from("map-work/tiles"), 384, 4),
            size_scale: 1.0,
            indicator_scale: 1.0,
            level: -1,
            mode: MapMode::default(),
            z_flip: true,
            player_dir: 0.0,
            camera_dir: 0.0,
            visible: false,
            player_pos: None,
            status_text: String::new(),
            wanted_next_frame: Vec::new(),
            show_hardcoded_treasures: true,
            treasure_points: Vec::new(),
            treasure_file_path: Self::default_treasure_file_path(),
            treasure_file_mtime: None,
            treasure_load_error_logged: false,
        }
    }

    pub fn size_scale(&self) -> f32 {
        self.size_scale
    }

    pub fn mode(&self) -> MapMode {
        self.mode
    }

    pub fn indicator_scale(&self) -> f32 {
        self.indicator_scale
    }

    pub fn level(&self) -> i32 {
        self.level
    }

    pub fn z_flip(&self) -> bool {
        self.z_flip
    }

    pub fn tiles_root(&self) -> String {
        self.tile_manager.root().to_string_lossy().into_owned()
    }

    pub fn set_size_scale(&mut self, value: f32) {
        self.size_scale = value.clamp(SIZE_SCALE_MIN, SIZE_SCALE_MAX);
    }

    pub fn set_indicator_scale(&mut self, value: f32) {
        self.indicator_scale = value.clamp(INDICATOR_SCALE_MIN, INDICATOR_SCALE_MAX);
    }

    pub fn set_mode(&mut self, value: MapMode) {
        self.mode = value;
    }

    pub fn set_level(&mut self, value: i32) {
        self.level = value;
    }

    pub fn set_z_flip(&mut self, value: bool) {
        self.z_flip = value;
    }

    pub fn set_tiles_root(&mut self, value: String) {
        let v = value.trim();
        if !v.is_empty() {
            let root = PathBuf::from(v);
            if self.tile_manager.root() == root {
                return;
            }
            match root.canonicalize() {
                Ok(abs) => {
                    info!("Map tiles root set: {} (resolved: {})", root.display(), abs.display());
                    util::append_log_line(&format!(
                        "map tiles root set: {} (resolved: {})",
                        root.display(),
                        abs.display()
                    ));
                },
                Err(e) => {
                    warn!("Map tiles root set: {} (resolve failed: {})", root.display(), e);
                    util::append_log_line(&format!(
                        "map tiles root set: {} (resolve failed: {})",
                        root.display(),
                        e
                    ));
                },
            }
            self.tile_manager.set_root(root);
        }
    }

    fn scales(&self, ui: &imgui::Ui) -> (f32, f32) {
        let base_scale = ui.io().display_size[1] / REFERENCE_HEIGHT;
        let scale = base_scale * self.size_scale;
        (base_scale, scale)
    }

    pub fn panel_toggle_position(&self, ui: &imgui::Ui, map_top_offset: f32) -> Option<[f32; 2]> {
        if !self.visible {
            return None;
        }
        let size = ui.io().display_size;
        let (base_scale, scale) = self.scales(ui);
        let map_hsize = MAP_HSIZE * scale;
        let map_x = size[0] - RIGHT * base_scale - map_hsize;
        let map_y = TOP * base_scale + map_hsize + map_top_offset;

        Some([
            map_x + map_hsize + PANEL_BUTTON_OFFSET_X * base_scale,
            map_y + map_hsize + PANEL_BUTTON_OFFSET_Y * base_scale,
        ])
    }

    pub fn render_panel_open_button(&self, ui: &imgui::Ui, pos: [f32; 2]) -> bool {
        let mut clicked = false;
        ui.window("##map_panel_open")
            .position(pos, Condition::Always)
            .position_pivot([1.0, 0.0])
            .bg_alpha(0.0)
            .flags(
                WindowFlags::NO_TITLE_BAR
                    | WindowFlags::NO_RESIZE
                    | WindowFlags::NO_MOVE
                    | WindowFlags::NO_SCROLLBAR
                    | WindowFlags::ALWAYS_AUTO_RESIZE,
            )
            .build(|| {
                clicked = ui.small_button("Config");
            });
        clicked
    }

    pub fn render_panel_close_button(&self, ui: &imgui::Ui, pos: [f32; 2]) -> bool {
        let mut clicked = false;
        ui.window("##map_panel_close")
            .position(pos, Condition::Always)
            .position_pivot([1.0, 0.0])
            .bg_alpha(0.0)
            .flags(
                WindowFlags::NO_TITLE_BAR
                    | WindowFlags::NO_RESIZE
                    | WindowFlags::NO_MOVE
                    | WindowFlags::NO_SCROLLBAR
                    | WindowFlags::ALWAYS_AUTO_RESIZE,
            )
            .build(|| {
                clicked = ui.small_button("Close");
            });
        clicked
    }

    pub fn render_config_panel(
        &mut self,
        ui: &imgui::Ui,
        panel_toggle_pos: [f32; 2],
    ) -> ConfigPanelResult {
        let mut size_scale = self.size_scale;
        let mut indicator_scale = self.indicator_scale;
        let mut level = self.level;
        let mut mode = self.mode;
        let mut tiles_root = self.tiles_root();
        let mut eject_requested = false;
        let mut panel_height = 0.0;
        let (base_scale, _scale) = self.scales(ui);
        let panel_pos = [
            panel_toggle_pos[0] + PANEL_WINDOW_OFFSET_X * base_scale,
            panel_toggle_pos[1] + ui.frame_height() + PANEL_WINDOW_OFFSET_Y * base_scale,
        ];

        ui.window("Map Controls")
            .position(panel_pos, Condition::Always)
            .position_pivot([1.0, 0.0])
            .bg_alpha(0.85)
            .flags(
                WindowFlags::ALWAYS_AUTO_RESIZE | WindowFlags::NO_MOVE | WindowFlags::NO_TITLE_BAR,
            )
            .build(|| {
                ui.text("Map Controls");
                if option_env!("CARGO_XTASK_DIST").is_none() {
                    ui.same_line();
                    if ui.small_button("Eject") {
                        eject_requested = true;
                    }
                }
                ui.same_line();
                if ui.small_button("Reset") {
                    size_scale = 1.0;
                    indicator_scale = 1.0;
                    mode = MapMode::SquareRotateWithPlayer;
                }
                ui.separator();

                ui.set_next_item_width(MAP_HSIZE * base_scale);
                ui.slider_config("Size Scale", SIZE_SCALE_MIN, SIZE_SCALE_MAX)
                    .display_format("%.2f")
                    .build(&mut size_scale);

                ui.set_next_item_width(MAP_HSIZE * base_scale);
                ui.slider_config("Indicator Scale", INDICATOR_SCALE_MIN, INDICATOR_SCALE_MAX)
                    .display_format("%.2f")
                    .build(&mut indicator_scale);

                let levels = self.tile_manager.available_levels();
                if !levels.is_empty() {
                    let mut selected_idx = levels
                        .iter()
                        .position(|(z, _)| *z == level)
                        .unwrap_or(levels.len().saturating_sub(1));
                    let level_labels: Vec<String> = levels
                        .iter()
                        .map(|(z, wu)| {
                            let mul = if *wu > 0.0 { 1.0 / *wu } else { 1.0 };
                            let mul_text = if (mul - mul.round()).abs() < 0.0001 {
                                format!("{:.0}x", mul.round())
                            } else {
                                format!("{:.2}x", mul)
                            };
                            format!("z={} ({})", z, mul_text)
                        })
                        .collect();
                    let level_refs: Vec<&str> = level_labels.iter().map(|s| s.as_str()).collect();
                    ui.set_next_item_width(MAP_HSIZE * base_scale * 1.2);
                    if ui.combo_simple_string("Scale Level", &mut selected_idx, &level_refs) {
                        level = levels[selected_idx].0;
                    }
                }

                let mut mode_idx = match mode {
                    MapMode::SquareNorthUp => 0,
                    MapMode::SquareRotateWithPlayer => 1,
                };
                let mode_items = [
                    "Square North-up",
                    "Square Rotate (Camera North)",
                ];
                ui.set_next_item_width(MAP_HSIZE * base_scale * 1.2);
                if ui.combo_simple_string("Map Mode", &mut mode_idx, &mode_items) {
                    mode = match mode_idx {
                        0 => MapMode::SquareNorthUp,
                        _ => MapMode::SquareRotateWithPlayer,
                    };
                }
                ui.set_next_item_width(MAP_HSIZE * base_scale * 1.4);
                ui.input_text("Tiles Root", &mut tiles_root).build();

                ui.separator();
                if let Some(_debug_token) = ui.tree_node("Debug") {
                    ui.checkbox("Show Hardcoded Treasures", &mut self.show_hardcoded_treasures);
                    ui.text(format!("Treasure File: {}", self.treasure_file_path.display()));
                    ui.text(format!("Treasure Points: {}", self.treasure_points.len()));
                    ui.text(format!("Visible: {}", self.visible));
                    ui.text(format!("Mode: {}", self.mode.as_str()));
                    ui.text(format!("Status: {}", self.status_text));
                    ui.text(format!("Tiles Root: {}", self.tile_manager.root().display()));
                    ui.text(format!(
                        "Index Loaded: {} (attempted={})",
                        self.tile_manager.has_index_loaded(),
                        self.tile_manager.index_attempted()
                    ));
                    ui.text(format!(
                        "Resident Tiles: {}/{}",
                        self.tile_manager.resident_tiles(),
                        self.tile_manager.max_resident_tiles()
                    ));
                    ui.text(format!("Wanted Next Frame: {}", self.wanted_next_frame.len()));
                    ui.text(format!("PlayerDir(rad): {:.3}", self.player_dir));
                    ui.text(format!("CameraDir(rad): {:.3}", self.camera_dir));
                    if let Some([x, y, z]) = self.player_pos {
                        ui.text(format!("Player Pos: {:7.1} {:7.1} {:7.1}", x, y, z));
                    } else {
                        ui.text("Player Pos: N/A");
                    }
                }

                panel_height = ui.window_size()[1];
            });

        let old = (
            self.size_scale,
            self.indicator_scale,
            self.level,
            self.mode,
            self.tiles_root(),
        );

        self.size_scale = size_scale.clamp(SIZE_SCALE_MIN, SIZE_SCALE_MAX);
        self.indicator_scale =
            indicator_scale.clamp(INDICATOR_SCALE_MIN, INDICATOR_SCALE_MAX);
        self.level = level;
        self.mode = mode;
        self.set_tiles_root(tiles_root);

        ConfigPanelResult {
            changed: old
                != (
                    self.size_scale,
                    self.indicator_scale,
                    self.level,
                    self.mode,
                    self.tiles_root(),
                ),
            eject_requested,
            occupied_height: (panel_pos[1] - panel_toggle_pos[1]) + panel_height,
        }
    }

    pub fn before_render<'a>(
        &'a mut self,
        _ctx: &mut Context,
        render_context: &'a mut dyn RenderContext,
    ) {
        self.pointer.prepare(render_context);
        self.camera_fov.prepare(render_context);
        self.marker_default.prepare(render_context);
        for tex in self.overlay_icons.values_mut() {
            tex.prepare(render_context);
        }
        self.tile_manager.begin_frame();
        self.tile_manager.prepare_needed(render_context, &self.wanted_next_frame);

        let (visible, player_dir, camera_dir) = self.camera_info.update();
        self.visible = visible;
        self.player_dir = player_dir;
        self.camera_dir = camera_dir;
        self.player_pos = self.camera_info.player_position();
        self.refresh_treasures_if_needed();

        let _ = self.tile_manager.index();
    }

    pub fn render(&mut self, ui: &imgui::Ui, top_offset: f32) {
        if !self.visible {
            return;
        }

        let size = ui.io().display_size;
        let (base_scale, scale) = self.scales(ui);
        let map_hsize = MAP_HSIZE * scale;
        let map_x = size[0] - RIGHT * base_scale - map_hsize;
        let map_y = TOP * base_scale + map_hsize + top_offset;
        let content_hsize = map_hsize;

        let draw_list = ui.get_foreground_draw_list();
        let clip_min = [map_x - map_hsize, map_y - map_hsize];
        let clip_max = [map_x + map_hsize, map_y + map_hsize];
        draw_list
            .add_rect(clip_min, clip_max, ImColor32::from_rgba_f32s(0.0, 0.0, 0.0, 1.0))
            .filled(true)
            .build();

        if self.tile_manager.index().is_none() {
            self.status_text =
                format!("index missing: {}", self.tile_manager.root().join("index.json").display());
            self.wanted_next_frame.clear();
            return;
        }
        let Some(player_pos) = self.player_pos else {
            self.status_text = "player unavailable".to_string();
            self.wanted_next_frame.clear();
            return;
        };

        let levels = self.tile_manager.available_levels();
        if levels.is_empty() {
            self.status_text = "invalid index levels".to_string();
            return;
        }
        if !levels.iter().any(|(z, _)| *z == self.level) {
            self.level = levels.last().map(|(z, _)| *z).unwrap_or(-1);
        }
        let level = self.level;
        let Some(target_wu_per_px) = self.tile_manager.level_world_units_per_px(level) else {
            self.status_text = "missing level scale".to_string();
            return;
        };
        let Some(tile_world_size) = self.tile_manager.level_tile_world_size(level) else {
            self.status_text = "missing level tile size".to_string();
            return;
        };
        let pointer_size = (POINTER_WORLD_SIZE_WU / target_wu_per_px) * self.indicator_scale;
        self.pointer.resize(pointer_size, pointer_size);
        self.camera_fov.resize(
            (CAMERA_FOV_WORLD_SIZE_WU / target_wu_per_px)
                * self.indicator_scale
                * CAMERA_FOV_SIZE_SCALE,
            (CAMERA_FOV_WORLD_SIZE_WU / target_wu_per_px)
                * self.indicator_scale
                * CAMERA_FOV_SIZE_SCALE,
        );

        let rot = match self.mode {
            MapMode::SquareNorthUp => 0.0,
            MapMode::SquareRotateWithPlayer => -self.camera_dir,
        };
        let player_z_for_map = if self.z_flip { -player_pos[2] } else { player_pos[2] };
        let center_x = (player_pos[0] / target_wu_per_px).round() * target_wu_per_px;
        let center_z = (player_z_for_map / target_wu_per_px).round() * target_wu_per_px;
        let view = MapViewParams {
            center_world_xz: [center_x, center_z],
            center_screen_px: [map_x, map_y],
            world_units_per_px: target_wu_per_px,
            half_extent_px: content_hsize,
            rotation_rad: rot,
            clip_mode: self.mode.as_clip_mode(),
        };

        let wanted = self.collect_wanted_tiles(TileCollectInput {
            view: &view,
            level,
            tile_world_size,
            target_wu_per_px,
            content_hsize,
            center_x,
            center_z,
        });
        self.wanted_next_frame = wanted.clone();

        draw_list.with_clip_rect(clip_min, clip_max, || {
            let mut corner_cache: HashMap<(i32, i32), [f32; 2]> =
                HashMap::with_capacity(wanted.len().saturating_mul(4));
            for key in &wanted {
                for &(gx, gy) in &[
                    (key.tx, key.ty),
                    (key.tx + 1, key.ty),
                    (key.tx + 1, key.ty + 1),
                    (key.tx, key.ty + 1),
                ] {
                    corner_cache.entry((gx, gy)).or_insert_with(|| {
                        let wx = gx as f32 * tile_world_size;
                        let wz = gy as f32 * tile_world_size;
                        view.world_to_screen([wx, wz])
                    });
                }
            }
            for key in &wanted {
                let Some(tex_id) = self.tile_manager.texture_for(*key) else { continue };
                let Some(&p1) = corner_cache.get(&(key.tx, key.ty)) else { continue };
                let Some(&p2) = corner_cache.get(&(key.tx + 1, key.ty)) else { continue };
                let Some(&p3) = corner_cache.get(&(key.tx + 1, key.ty + 1)) else { continue };
                let Some(&p4) = corner_cache.get(&(key.tx, key.ty + 1)) else { continue };
                draw_list.add_image_quad(tex_id, p1, p2, p3, p4).build();
            }
        });

        draw_list
            .add_rect(clip_min, clip_max, ImColor32::from_rgba_f32s(1.0, 1.0, 1.0, 0.9))
            .thickness(2.0)
            .build();

        let camera_fov_rot = match self.mode {
            MapMode::SquareNorthUp => self.camera_dir,
            MapMode::SquareRotateWithPlayer => 0.0,
        };
        draw_list.with_clip_rect(clip_min, clip_max, || {
            self.camera_fov.render_rotate(&draw_list, [map_x, map_y], camera_fov_rot);
        });

        // player_arrow.png is authored with center pivot.
        debug_assert_eq!(PLAYER_ARROW_PIVOT, [0.5, 0.5]);
        let arrow_fix = std::f32::consts::PI;
        let pointer_rot = match self.mode {
            MapMode::SquareNorthUp => self.player_dir + arrow_fix,
            MapMode::SquareRotateWithPlayer => self.player_dir - self.camera_dir + arrow_fix,
        };
        self.pointer.render_rotate(&draw_list, [map_x, map_y], pointer_rot);

        if self.show_hardcoded_treasures {
            self.enqueue_hardcoded_treasures();
        }
        self.render_overlays(ui, &draw_list, clip_min, clip_max, &view, target_wu_per_px);

        let tile_size_px = self.tile_manager.tile_size_px().unwrap_or(0);
        self.status_text = format!(
            "level={} wu_per_px={:.5} wanted_tiles={} tile_px={}",
            level, target_wu_per_px, wanted.len(), tile_size_px
        );
    }
}
