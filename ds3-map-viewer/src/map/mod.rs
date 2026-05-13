mod camera_info;
mod geometry;
pub mod overlay;
mod texture;
mod tile;

use std::path::PathBuf;

use geometry::{ClipMode, MapViewParams, Visibility};
use hudhook::RenderContext;
use imgui::{Condition, Context, ImColor32, WindowFlags};
use libds3::pointers::PointerChains;
use tile::{TileKey, TileManager};

use crate::map::camera_info::CameraInfo;
use crate::map::texture::Texture;

const REFERENCE_HEIGHT: f32 = 1080.0;
const RIGHT: f32 = 23.0;
const TOP: f32 = 30.0;
const MAP_SIZE: f32 = 192.0;
const MAP_HSIZE: f32 = MAP_SIZE * 0.5;
const POINTER_SIZE: f32 = 48.0;
const PLAYER_ARROW_PIVOT: [f32; 2] = overlay::PLAYER_ARROW_PIVOT;
const PANEL_BUTTON_OFFSET_X: f32 = 0.0;
const PANEL_WINDOW_OFFSET_X: f32 = -4.0;
const PANEL_WINDOW_OFFSET_Y: f32 = 2.0;
pub(crate) const DIRECTION_OFFSET_MIN: f32 = -180.0;
pub(crate) const DIRECTION_OFFSET_MAX: f32 = 180.0;
pub(crate) const SIZE_SCALE_MIN: f32 = 0.5;
pub(crate) const SIZE_SCALE_MAX: f32 = 3.0;
pub(crate) const ZOOM_SCALE_MIN: f32 = 0.25;
pub(crate) const ZOOM_SCALE_MAX: f32 = 8.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MapMode {
    CircleNorthUp,
    #[default]
    SquareRotateWithPlayer,
}

impl MapMode {
    pub fn as_clip_mode(self) -> ClipMode {
        match self {
            MapMode::CircleNorthUp => ClipMode::CircleNorthUp,
            MapMode::SquareRotateWithPlayer => ClipMode::SquareRotateWithPlayer,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            MapMode::CircleNorthUp => "circle_north_up",
            MapMode::SquareRotateWithPlayer => "square_rotate_with_player",
        }
    }
}

pub struct MapViewer {
    pointer: Texture,
    marker_default: Texture,
    camera_info: CameraInfo,
    tile_manager: TileManager,

    direction_offset_degrees: f32,
    size_scale: f32,
    zoom_scale: f32,
    mode: MapMode,

    dir: f32,
    visible: bool,
    player_pos: Option<[f32; 3]>,
    status_text: String,
    wanted_next_frame: Vec<TileKey>,
}

pub struct ConfigPanelResult {
    pub changed: bool,
    pub eject_requested: bool,
    pub occupied_height: f32,
}

impl MapViewer {
    fn apply_circle_mask(
        draw_list: &imgui::DrawListMut<'_>,
        center: [f32; 2],
        radius: f32,
        color: ImColor32,
    ) {
        let min_x = center[0] - radius;
        let max_x = center[0] + radius;
        let min_y = center[1] - radius;
        let max_y = center[1] + radius;
        let steps = radius.max(32.0) as i32;
        for i in 0..steps {
            let t0 = i as f32 / steps as f32;
            let t1 = (i + 1) as f32 / steps as f32;
            let x0 = min_x + (max_x - min_x) * t0;
            let x1 = min_x + (max_x - min_x) * t1;
            let xm = (x0 + x1) * 0.5;
            let dx = (xm - center[0]).abs();
            let y = (radius * radius - dx * dx).max(0.0).sqrt();
            let top = center[1] - y;
            let bottom = center[1] + y;
            draw_list.add_rect([x0, min_y], [x1, top], color).filled(true).build();
            draw_list.add_rect([x0, bottom], [x1, max_y], color).filled(true).build();
        }
    }

    pub fn new(pointers: &PointerChains) -> Self {
        let pointer = Texture::new(include_bytes!("icons/player_arrow.png"), None);
        let marker_default = Texture::new(include_bytes!("icons/marker_default.png"), None);
        let camera_info = CameraInfo::new(pointers);

        MapViewer {
            pointer,
            marker_default,
            camera_info,
            tile_manager: TileManager::new(PathBuf::from("map-work/tiles"), 384, 4),
            direction_offset_degrees: 0.0,
            size_scale: 1.0,
            zoom_scale: 1.0,
            mode: MapMode::default(),
            dir: 0.0,
            visible: false,
            player_pos: None,
            status_text: String::new(),
            wanted_next_frame: Vec::new(),
        }
    }

    pub fn direction_offset_degrees(&self) -> f32 {
        self.direction_offset_degrees
    }

    pub fn size_scale(&self) -> f32 {
        self.size_scale
    }

    pub fn zoom_scale(&self) -> f32 {
        self.zoom_scale
    }

    pub fn mode(&self) -> MapMode {
        self.mode
    }

    pub fn tiles_root(&self) -> String {
        self.tile_manager.root().to_string_lossy().into_owned()
    }

    pub fn set_direction_offset_degrees(&mut self, value: f32) {
        self.direction_offset_degrees = value.clamp(DIRECTION_OFFSET_MIN, DIRECTION_OFFSET_MAX);
    }

    pub fn set_size_scale(&mut self, value: f32) {
        self.size_scale = value.clamp(SIZE_SCALE_MIN, SIZE_SCALE_MAX);
    }

    pub fn set_zoom_scale(&mut self, value: f32) {
        self.zoom_scale = value.clamp(ZOOM_SCALE_MIN, ZOOM_SCALE_MAX);
    }

    pub fn set_mode(&mut self, value: MapMode) {
        self.mode = value;
    }

    pub fn set_tiles_root(&mut self, value: String) {
        let v = value.trim();
        if !v.is_empty() {
            self.tile_manager.set_root(PathBuf::from(v));
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

        Some([map_x + map_hsize + PANEL_BUTTON_OFFSET_X * base_scale, map_y - map_hsize])
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
        let mut direction_offset = self.direction_offset_degrees;
        let mut size_scale = self.size_scale;
        let mut zoom_scale = self.zoom_scale;
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
                    direction_offset = 0.0;
                    size_scale = 1.0;
                    zoom_scale = 1.0;
                    mode = MapMode::SquareRotateWithPlayer;
                }
                ui.separator();

                ui.set_next_item_width(MAP_HSIZE * base_scale);
                ui.slider_config(
                    "Direction Offset (deg)",
                    DIRECTION_OFFSET_MIN,
                    DIRECTION_OFFSET_MAX,
                )
                .display_format("%.1f")
                .build(&mut direction_offset);

                ui.set_next_item_width(MAP_HSIZE * base_scale);
                ui.slider_config("Size Scale", SIZE_SCALE_MIN, SIZE_SCALE_MAX)
                    .display_format("%.2f")
                    .build(&mut size_scale);

                ui.set_next_item_width(MAP_HSIZE * base_scale);
                ui.slider_config("Zoom Scale", ZOOM_SCALE_MIN, ZOOM_SCALE_MAX)
                    .display_format("%.2f")
                    .build(&mut zoom_scale);

                let mut circle = matches!(mode, MapMode::CircleNorthUp);
                if ui.checkbox("Circle North-up", &mut circle) {
                    mode = if circle {
                        MapMode::CircleNorthUp
                    } else {
                        MapMode::SquareRotateWithPlayer
                    };
                }

                ui.set_next_item_width(MAP_HSIZE * base_scale * 1.4);
                ui.input_text("Tiles Root", &mut tiles_root).build();

                ui.separator();
                if let Some(_debug_token) = ui.tree_node("Debug") {
                    ui.text(format!("Visible: {}", self.visible));
                    ui.text(format!("Mode: {}", self.mode.as_str()));
                    ui.text(format!("Status: {}", self.status_text));
                    if let Some([x, y, z]) = self.player_pos {
                        ui.text(format!("Player Pos: {:7.1} {:7.1} {:7.1}", x, y, z));
                    } else {
                        ui.text("Player Pos: N/A");
                    }
                }

                panel_height = ui.window_size()[1];
            });

        let old = (
            self.direction_offset_degrees,
            self.size_scale,
            self.zoom_scale,
            self.mode,
            self.tiles_root(),
        );

        self.direction_offset_degrees =
            direction_offset.clamp(DIRECTION_OFFSET_MIN, DIRECTION_OFFSET_MAX);
        self.size_scale = size_scale.clamp(SIZE_SCALE_MIN, SIZE_SCALE_MAX);
        self.zoom_scale = zoom_scale.clamp(ZOOM_SCALE_MIN, ZOOM_SCALE_MAX);
        self.mode = mode;
        self.set_tiles_root(tiles_root);

        ConfigPanelResult {
            changed: old
                != (
                    self.direction_offset_degrees,
                    self.size_scale,
                    self.zoom_scale,
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
        self.marker_default.prepare(render_context);
        self.tile_manager.begin_frame();
        self.tile_manager.prepare_needed(render_context, &self.wanted_next_frame);

        let (visible, dir) = self.camera_info.update();
        self.visible = visible;
        self.dir = dir;
        self.player_pos = self.camera_info.player_position();

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

        let pointer_size = POINTER_SIZE * scale;
        self.pointer.resize(pointer_size, pointer_size);

        if self.tile_manager.index().is_none() {
            self.status_text =
                format!("index missing: {}", self.tile_manager.root().join("index.json").display());
            return;
        }
        let Some(player_pos) = self.player_pos else {
            self.status_text = "player unavailable".to_string();
            return;
        };

        let target_wu_per_px = (MAP_SIZE / 512.0) * self.zoom_scale;
        let Some(level) = self.tile_manager.pick_level_auto(target_wu_per_px) else {
            self.status_text = "invalid index levels".to_string();
            return;
        };
        let Some(tile_world_size) = self.tile_manager.level_tile_world_size(level) else {
            self.status_text = "missing level tile size".to_string();
            return;
        };

        let rot = match self.mode {
            MapMode::CircleNorthUp => 0.0,
            MapMode::SquareRotateWithPlayer => {
                -(self.dir + self.direction_offset_degrees.to_radians())
            },
        };
        let view = MapViewParams {
            center_world_xz: [player_pos[0], player_pos[2]],
            center_screen_px: [map_x, map_y],
            world_units_per_px: target_wu_per_px,
            half_extent_px: map_hsize,
            rotation_rad: rot,
            clip_mode: self.mode.as_clip_mode(),
        };

        let draw_list = ui.get_foreground_draw_list();
        let clip_min = [map_x - map_hsize, map_y - map_hsize];
        let clip_max = [map_x + map_hsize, map_y + map_hsize];

        let min_x = player_pos[0] - map_hsize * target_wu_per_px;
        let max_x = player_pos[0] + map_hsize * target_wu_per_px;
        let min_z = player_pos[2] - map_hsize * target_wu_per_px;
        let max_z = player_pos[2] + map_hsize * target_wu_per_px;
        let tx0 = (min_x / tile_world_size).floor() as i32;
        let tx1 = (max_x / tile_world_size).ceil() as i32;
        let ty0 = (min_z / tile_world_size).floor() as i32;
        let ty1 = (max_z / tile_world_size).ceil() as i32;

        let mut wanted = Vec::new();
        for tx in tx0..=tx1 {
            for ty in ty0..=ty1 {
                let key = TileKey { z: level, tx, ty };
                if !self.tile_manager.has_tile(key) {
                    continue;
                }
                let world_aabb = [
                    tx as f32 * tile_world_size,
                    (tx + 1) as f32 * tile_world_size,
                    ty as f32 * tile_world_size,
                    (ty + 1) as f32 * tile_world_size,
                ];
                if !matches!(view.tile_visibility(world_aabb), Visibility::Hidden) {
                    wanted.push(key);
                }
            }
        }
        self.wanted_next_frame = wanted.clone();

        draw_list.with_clip_rect(clip_min, clip_max, || {
            for key in &wanted {
                let Some(tex_id) = self.tile_manager.texture_for(*key) else { continue };
                let x0 = key.tx as f32 * tile_world_size;
                let x1 = (key.tx + 1) as f32 * tile_world_size;
                let z0 = key.ty as f32 * tile_world_size;
                let z1 = (key.ty + 1) as f32 * tile_world_size;
                let p1 = view.world_to_screen([x0, z0]);
                let p2 = view.world_to_screen([x1, z0]);
                let p3 = view.world_to_screen([x1, z1]);
                let p4 = view.world_to_screen([x0, z1]);
                draw_list.add_image_quad(tex_id, p1, p2, p3, p4).build();
            }
        });

        if matches!(self.mode, MapMode::CircleNorthUp) {
            Self::apply_circle_mask(
                &draw_list,
                [map_x, map_y],
                map_hsize,
                ImColor32::from_rgba_f32s(0.02, 0.02, 0.02, 1.0),
            );
            draw_list
                .add_circle(
                    [map_x, map_y],
                    map_hsize,
                    ImColor32::from_rgba_f32s(1.0, 1.0, 1.0, 0.9),
                )
                .thickness(2.0)
                .build();
        } else {
            draw_list
                .add_rect(clip_min, clip_max, ImColor32::from_rgba_f32s(1.0, 1.0, 1.0, 0.9))
                .thickness(2.0)
                .build();
        }

        // player_arrow.png is authored with center pivot.
        debug_assert_eq!(PLAYER_ARROW_PIVOT, [0.5, 0.5]);
        self.pointer.render(ui, [map_x, map_y]);

        for item in overlay::take_frame_items() {
            match item {
                overlay::OverlayItem::Icon { world_xz, size_px, pivot, color: _ } => {
                    if let Some(v) = view.marker_visibility(world_xz, size_px, pivot) {
                        self.marker_default.render_rect(ui, v.screen_rect);
                    }
                },
                overlay::OverlayItem::Text { world_xz, text, color, size_px, pivot } => {
                    if let Some(v) = view.marker_visibility(world_xz, size_px, pivot) {
                        draw_list.add_text(
                            [v.screen_rect[0], v.screen_rect[1]],
                            ImColor32::from_rgba_f32s(color[0], color[1], color[2], color[3]),
                            text,
                        );
                    }
                },
                overlay::OverlayItem::IconText {
                    world_xz,
                    text,
                    color: _,
                    icon_size_px,
                    spacing_px,
                } => {
                    let total_h = icon_size_px[1] + spacing_px + 14.0;
                    if let Some(v) =
                        view.marker_visibility(world_xz, [icon_size_px[0], total_h], [0.5, 0.5])
                    {
                        let cx = v.screen_anchor[0];
                        let top = v.screen_anchor[1] - total_h * 0.5;
                        self.marker_default.render_rect(
                            ui,
                            [
                                cx - icon_size_px[0] * 0.5,
                                top,
                                cx + icon_size_px[0] * 0.5,
                                top + icon_size_px[1],
                            ],
                        );
                        draw_list.add_text(
                            [cx - (text.len() as f32 * 3.0), top + icon_size_px[1] + spacing_px],
                            ImColor32::from_rgba_f32s(1.0, 1.0, 1.0, 1.0),
                            text,
                        );
                    }
                },
            }
        }

        let tile_size_px = self.tile_manager.tile_size_px().unwrap_or(0);
        self.status_text =
            format!("level={} wanted_tiles={} tile_px={}", level, wanted.len(), tile_size_px);
    }
}
