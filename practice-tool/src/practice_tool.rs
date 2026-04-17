use std::sync::atomic::AtomicBool;

use hudhook::{ImguiRenderLoop, RenderContext};
use imgui::{Condition, Context, Key, WindowFlags};
use libds3::pointers::PointerChains;

use crate::map::MapViewer;

pub(crate) static BLOCK_XINPUT: AtomicBool = AtomicBool::new(false);

pub(crate) struct PracticeTool {
    map_viewer: MapViewer,
    show_panel: bool,
}

impl PracticeTool {
    pub(crate) fn new() -> Self {
        let pointers = PointerChains::new();
        let map_viewer = MapViewer::new(&pointers);
        PracticeTool { map_viewer, show_panel: false }
    }

    fn render_config_panel(&mut self, ui: &imgui::Ui) {
        let mut direction_offset = self.map_viewer.direction_offset_degrees();
        let mut size_scale = self.map_viewer.size_scale();

        ui.window("Compass Controls")
            .position([20.0, 20.0], Condition::FirstUseEver)
            .bg_alpha(0.85)
            .flags(WindowFlags::ALWAYS_AUTO_RESIZE)
            .build(|| {
                ui.text("Toggle: F6");
                ui.separator();

                ui.slider_config("Direction Offset (deg)", -180.0, 180.0)
                    .display_format("%.1f")
                    .build(&mut direction_offset);

                ui.slider_config("Size Scale", 0.5, 3.0)
                    .display_format("%.2f")
                    .build(&mut size_scale);
            });

        self.map_viewer.set_direction_offset_degrees(direction_offset);
        self.map_viewer.set_size_scale(size_scale);
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
            self.render_config_panel(ui);
        }

        self.map_viewer.render(ui);
    }
}
