use std::sync::atomic::AtomicBool;

use hudhook::{ImguiRenderLoop, RenderContext};
use imgui::{Context, Key};
use libds3::pointers::PointerChains;

use crate::config::{ConfigStore, MapConfig};
use crate::map::MapViewer;

pub(crate) static BLOCK_XINPUT: AtomicBool = AtomicBool::new(false);

pub(crate) struct PracticeTool {
    config_store: ConfigStore,
    map_viewer: MapViewer,
    show_panel: bool,
}

impl PracticeTool {
    pub(crate) fn new() -> Self {
        let config_store = ConfigStore::load();
        let pointers = PointerChains::new();
        let mut map_viewer = MapViewer::new(&pointers);
        map_viewer.set_direction_offset_degrees(
            config_store.config().map.compass_direction_offset_degrees,
        );
        map_viewer.set_size_scale(config_store.config().map.compass_size_scale);

        PracticeTool { config_store, map_viewer, show_panel: false }
    }

}

impl ImguiRenderLoop for PracticeTool {
    fn before_render(&mut self, ctx: &mut Context, r: &mut dyn RenderContext) {
        self.map_viewer.before_render(ctx, r);
    }

    fn render(&mut self, ui: &mut imgui::Ui) {
        if ui.is_key_pressed(Key::F6) {
            self.show_panel = !self.show_panel;
        }

        if self.show_panel {
            let changed = self.map_viewer.render_config_panel(ui);
            if changed {
                self.config_store.set_map(MapConfig {
                    compass_direction_offset_degrees: self.map_viewer.direction_offset_degrees(),
                    compass_size_scale: self.map_viewer.size_scale(),
                });
                self.config_store.save();
            }
        }

        self.map_viewer.render(ui);
    }
}
