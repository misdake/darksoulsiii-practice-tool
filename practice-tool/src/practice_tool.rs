use std::sync::atomic::AtomicBool;

use hudhook::{ImguiRenderLoop, RenderContext};
use imgui::Context;
use libds3::pointers::PointerChains;

use crate::map::MapViewer;

pub(crate) static BLOCK_XINPUT: AtomicBool = AtomicBool::new(false);

pub(crate) struct PracticeTool {
    map_viewer: MapViewer,
}

impl PracticeTool {
    pub(crate) fn new() -> Self {
        let pointers = PointerChains::new();
        let map_viewer = MapViewer::new(&pointers);
        PracticeTool { map_viewer }
    }
}

impl ImguiRenderLoop for PracticeTool {
    fn before_render(&mut self, ctx: &mut Context, r: &mut dyn RenderContext) {
        self.map_viewer.before_render(ctx, r);
    }

    fn render(&mut self, ui: &mut imgui::Ui) {
        self.map_viewer.render(ui);
    }
}
