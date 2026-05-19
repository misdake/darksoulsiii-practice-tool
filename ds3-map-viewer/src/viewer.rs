use std::sync::atomic::AtomicBool;

use hudhook::{eject, ImguiRenderLoop, RenderContext};
use imgui::{Context, StyleVar};
use libds3::pointers::PointerChains;

use crate::config::{ConfigStore, MapConfig};
use crate::map::MapViewer;

pub(crate) static BLOCK_XINPUT: AtomicBool = AtomicBool::new(false);

pub(crate) struct Viewer {
    config_store: ConfigStore,
    pointers: PointerChains,
    map_viewer: MapViewer,
    show_panel: bool,
    panel_occupied_height: f32,
}

impl Viewer {
    pub(crate) fn new() -> Self {
        let config_store = ConfigStore::load();
        let pointers = PointerChains::new();
        let mut map_viewer = MapViewer::new(&pointers);
        Self::apply_map_config(config_store.config().map.clone(), &mut map_viewer);

        Viewer { config_store, pointers, map_viewer, show_panel: false, panel_occupied_height: 0.0 }
    }

    fn apply_map_config(map_config: MapConfig, map_viewer: &mut MapViewer) {
        map_viewer.set_size_scale(map_config.map_size_scale);
        map_viewer.set_indicator_scale(map_config.map_indicator_scale);
        map_viewer.set_level(map_config.map_level);
        map_viewer.set_mode(map_config.mode());
        map_viewer.set_tiles_root(map_config.map_tiles_root);
        map_viewer.set_z_flip(map_config.map_z_flip);
    }

    fn save_map_config(&mut self) {
        let mut config = MapConfig {
            map_size_scale: self.map_viewer.size_scale(),
            map_indicator_scale: self.map_viewer.indicator_scale(),
            map_level: self.map_viewer.level(),
            map_mode: String::new(),
            map_tiles_root: self.map_viewer.tiles_root(),
            map_z_flip: self.map_viewer.z_flip(),
            map_zoom_scale: None,
        };
        config.set_mode(self.map_viewer.mode());
        self.config_store.set_map(config);
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

impl ImguiRenderLoop for Viewer {
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

        self.map_viewer.render(ui, 0.0);
    }
}
