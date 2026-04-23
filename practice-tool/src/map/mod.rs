mod camera_info;
mod texture;

use hudhook::RenderContext;
use imgui::{Condition, Context, WindowFlags};
use libds3::pointers::PointerChains;

use crate::map::camera_info::CameraInfo;
use crate::map::texture::Texture;

// all expected sizes in 1080 height.
const REFERENCE_HEIGHT: f32 = 1080.;
const RIGHT: f32 = 23.;
const TOP: f32 = 30.;
const COMPASS_SIZE: f32 = 192.;
const COMPASS_HSIZE: f32 = COMPASS_SIZE * 0.5;
const POINTER_SIZE: f32 = 128.;
const POINTER_OFFSET: f32 = 10.;
const PANEL_BUTTON_OFFSET_X: f32 = 0.0;
const PANEL_WINDOW_OFFSET_X: f32 = -4.0;
const PANEL_WINDOW_OFFSET_Y: f32 = 2.0;
pub(crate) const DIRECTION_OFFSET_MIN: f32 = -180.0;
pub(crate) const DIRECTION_OFFSET_MAX: f32 = 180.0;
pub(crate) const SIZE_SCALE_MIN: f32 = 0.5;
pub(crate) const SIZE_SCALE_MAX: f32 = 3.0;

pub struct MapViewer {
    compass: Texture,
    pointer: Texture,
    camera_info: CameraInfo,

    direction_offset_degrees: f32,
    size_scale: f32,
    dir: f32,
    visible: bool,
}

pub struct ConfigPanelResult {
    pub changed: bool,
    pub eject_requested: bool,
    pub occupied_height: f32,
}

impl MapViewer {
    pub fn new(pointers: &PointerChains) -> Self {
        let compass = Texture::new(include_bytes!("compass.png"), None);
        let pointer = Texture::new(include_bytes!("pointer.png"), None);

        let camera_info = CameraInfo::new(pointers);

        MapViewer {
            compass,
            pointer,
            camera_info,
            direction_offset_degrees: 0.0,
            size_scale: 1.0,
            dir: 0.0,
            visible: false,
        }
    }
}

impl MapViewer {
    pub fn direction_offset_degrees(&self) -> f32 {
        self.direction_offset_degrees
    }

    pub fn size_scale(&self) -> f32 {
        self.size_scale
    }

    pub fn set_direction_offset_degrees(&mut self, value: f32) {
        self.direction_offset_degrees = value.clamp(DIRECTION_OFFSET_MIN, DIRECTION_OFFSET_MAX);
    }

    pub fn set_size_scale(&mut self, value: f32) {
        self.size_scale = value.clamp(SIZE_SCALE_MIN, SIZE_SCALE_MAX);
    }

    fn scales(&self, ui: &imgui::Ui) -> (f32, f32) {
        let base_scale = ui.io().display_size[1] / REFERENCE_HEIGHT;
        let scale = base_scale * self.size_scale;
        (base_scale, scale)
    }

    pub fn panel_toggle_position(
        &self,
        ui: &imgui::Ui,
        compass_top_offset: f32,
    ) -> Option<[f32; 2]> {
        if !self.visible {
            return None;
        }

        let size = ui.io().display_size;
        let (base_scale, scale) = self.scales(ui);
        let compass_hsize = COMPASS_HSIZE * scale;
        let compass_x = size[0] - RIGHT * base_scale - compass_hsize;
        let compass_y = TOP * base_scale + compass_hsize + compass_top_offset;

        Some([
            compass_x + compass_hsize + PANEL_BUTTON_OFFSET_X * base_scale,
            compass_y - compass_hsize,
        ])
    }

    pub fn render_panel_open_button(&self, ui: &imgui::Ui, pos: [f32; 2]) -> bool {
        let mut clicked = false;
        ui.window("##compass_panel_open")
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
        ui.window("##compass_panel_close")
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
        let mut eject_requested = false;
        let mut panel_height = 0.0;
        let map_enabled = self.visible;
        let player_position = self.camera_info.player_position();
        let camera_position = self.camera_info.camera_position();
        let (base_scale, _scale) = self.scales(ui);
        let panel_pos = [
            panel_toggle_pos[0] + PANEL_WINDOW_OFFSET_X * base_scale,
            panel_toggle_pos[1] + ui.frame_height() + PANEL_WINDOW_OFFSET_Y * base_scale,
        ];

        ui.window("Compass Controls")
            .position(panel_pos, Condition::Always)
            .position_pivot([1.0, 0.0])
            .bg_alpha(0.85)
            .flags(
                WindowFlags::ALWAYS_AUTO_RESIZE | WindowFlags::NO_MOVE | WindowFlags::NO_TITLE_BAR,
            )
            .build(|| {
                ui.text("Compass Controls");
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
                }
                ui.separator();

                ui.set_next_item_width(COMPASS_HSIZE * base_scale);
                ui.slider_config(
                    "Direction Offset (deg)",
                    DIRECTION_OFFSET_MIN,
                    DIRECTION_OFFSET_MAX,
                )
                .display_format("%.1f")
                .build(&mut direction_offset);

                ui.set_next_item_width(COMPASS_HSIZE * base_scale);
                ui.slider_config("Size Scale", SIZE_SCALE_MIN, SIZE_SCALE_MAX)
                    .display_format("%.2f")
                    .build(&mut size_scale);

                ui.separator();
                if let Some(_debug_token) = ui.tree_node("Debug") {
                    ui.text(format!(
                        "Minimap Enabled: {}",
                        if map_enabled { "true" } else { "false" }
                    ));

                    match player_position {
                        Some([x, y, z]) => {
                            ui.text("Player Pos:");
                            ui.text(format!("{:7.1} {:7.1} {:7.1}", x, y, z));
                        },
                        None => {
                            ui.text("Player Pos:");
                            ui.text("N/A");
                        },
                    }

                    match camera_position {
                        Some([x, y, z]) => {
                            ui.text("Camera Pos:");
                            ui.text(format!("{:7.1} {:7.1} {:7.1}", x, y, z));
                        },
                        None => {
                            ui.text("Camera Pos:");
                            ui.text("N/A");
                        },
                    }
                }

                panel_height = ui.window_size()[1];
            });

        let old_direction_offset = self.direction_offset_degrees;
        let old_size_scale = self.size_scale;

        self.direction_offset_degrees =
            direction_offset.clamp(DIRECTION_OFFSET_MIN, DIRECTION_OFFSET_MAX);
        self.size_scale = size_scale.clamp(SIZE_SCALE_MIN, SIZE_SCALE_MAX);

        ConfigPanelResult {
            changed: (self.direction_offset_degrees - old_direction_offset).abs() > f32::EPSILON
                || (self.size_scale - old_size_scale).abs() > f32::EPSILON,
            eject_requested,
            occupied_height: (panel_pos[1] - panel_toggle_pos[1]) + panel_height,
        }
    }

    pub fn before_render<'a>(
        &'a mut self,
        _ctx: &mut Context,
        render_context: &'a mut dyn RenderContext,
    ) {
        // load textures if not loaded
        self.compass.prepare(render_context);
        self.pointer.prepare(render_context);

        // read memory and decide dir & visibility
        let (visible, dir) = self.camera_info.update();
        self.visible = visible;
        self.dir = dir;
    }

    pub fn render(&mut self, ui: &imgui::Ui, top_offset: f32) {
        let size = ui.io().display_size;
        let (base_scale, scale) = self.scales(ui);

        let c = COMPASS_SIZE * scale;
        let p = POINTER_SIZE * scale;
        self.compass.resize(c, c);
        self.pointer.resize(p, p);

        if !self.visible {
            return;
        }

        let compass_hsize = COMPASS_HSIZE * scale;
        let compass_x = size[0] - RIGHT * base_scale - compass_hsize;
        let compass_y = TOP * base_scale + compass_hsize + top_offset;
        let pointer_x = compass_x;
        let pointer_y = compass_y + POINTER_OFFSET * scale;
        let direction_offset = self.direction_offset_degrees.to_radians();
        self.compass.render(ui, [compass_x, compass_y]);
        self.pointer.render_rotate(ui, [pointer_x, pointer_y], self.dir + direction_offset);
    }
}
