use std::sync::atomic::{AtomicBool, Ordering};

use hudhook::{eject, ImguiRenderLoop, RenderContext};
use imgui::{Context, StyleVar};
use libds3::pointers::PointerChains;

use crate::config::{ConfigStore, MapConfig};
use crate::map::MapViewer;

pub(crate) static BLOCK_XINPUT: AtomicBool = AtomicBool::new(false);

pub(crate) struct PracticeTool {
    config_store: ConfigStore,
    pointers: PointerChains,
    map_viewer: MapViewer,
    show_panel: bool,
    panel_occupied_height: f32,
}

impl PracticeTool {
    pub(crate) fn new() -> Self {
        let config_store = ConfigStore::load();
        let pointers = PointerChains::new();
        let mut map_viewer = MapViewer::new(&pointers);
        Self::apply_map_config(config_store.config().map.clone(), &mut map_viewer);

        PracticeTool {
            config_store,
            pointers,
            map_viewer,
            show_panel: false,
            panel_occupied_height: 0.0,
        }
    }

    fn apply_map_config(map_config: MapConfig, map_viewer: &mut MapViewer) {
        map_viewer.set_direction_offset_degrees(map_config.compass_direction_offset_degrees);
        map_viewer.set_size_scale(map_config.compass_size_scale);
    }

    fn save_map_config(&mut self) {
        self.config_store.set_map(MapConfig {
            compass_direction_offset_degrees: self.map_viewer.direction_offset_degrees(),
            compass_size_scale: self.map_viewer.size_scale(),
        });
        self.config_store.save();
    }

    fn set_panel_visibility(&mut self, show: bool) {
        self.pointers.cursor_show.set(show);

        if self.show_panel == show {
            return;
        }

        self.show_panel = show;
        if !show {
            self.panel_occupied_height = 0.0;
        }
    }
}

impl ImguiRenderLoop for PracticeTool {
    fn before_render(&mut self, ctx: &mut Context, r: &mut dyn RenderContext) {
        self.map_viewer.before_render(ctx, r);
    }

    fn render(&mut self, ui: &mut imgui::Ui) {
        let _stack_tokens = [
            ui.push_style_var(StyleVar::WindowRounding(0.)),
            ui.push_style_var(StyleVar::FrameBorderSize(0.)),
            ui.push_style_var(StyleVar::WindowBorderSize(0.)),
        ];

        let panel_toggle_pos = self.map_viewer.panel_toggle_position(ui, 0.0);

        if self.show_panel {
            self.pointers.cursor_show.set(true);
            if let Some(pos) = panel_toggle_pos {
                if self.map_viewer.render_panel_close_button(ui, pos) {
                    self.set_panel_visibility(false);
                }
            } else {
                self.set_panel_visibility(false);
            }
        } else if let Some(pos) = panel_toggle_pos {
            if self.map_viewer.render_panel_open_button(ui, pos) {
                self.set_panel_visibility(true);
            }
        }

        BLOCK_XINPUT.store(self.show_panel, Ordering::SeqCst);

        if self.show_panel {
            let Some(pos) = panel_toggle_pos else {
                self.map_viewer.render(ui, 0.0);
                return;
            };

            let panel = self.map_viewer.render_config_panel(ui, pos);
            if panel.changed {
                self.save_map_config();
            }
            self.panel_occupied_height = panel.occupied_height;
            if panel.eject_requested {
                self.set_panel_visibility(false);
                eject();
            }
        }

        let compass_top_offset = if self.show_panel { self.panel_occupied_height } else { 0.0 };
        self.map_viewer.render(ui, compass_top_offset);
    }
}
