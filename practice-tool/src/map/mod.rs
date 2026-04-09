mod camera_info;
mod texture;

use hudhook::RenderContext;
use imgui::Context;
use libds3::pointers::PointerChains;

use crate::map::camera_info::CameraInfo;
use crate::map::texture::Texture;

// all expected sizes in 1080 height.
const REFERENCE_HEIGHT: f32 = 1080.;
const RIGHT: f32 = 23.;
const TOP: f32 = 30.;
const COMPASS_SIZE: f32 = 192.;
const COMPASS_HSIZE: f32 = 96.;
const POINTER_SIZE: f32 = 128.;
const POINTER_OFFSET: f32 = 10.;

pub struct MapViewer {
    compass: Texture,
    pointer: Texture,
    camera_info: CameraInfo,

    prev_size: Option<[f32; 2]>,
    dir: f32,
    visible: bool,
}

impl MapViewer {
    pub fn new(pointers: &PointerChains) -> Self {
        let compass = Texture::new(include_bytes!("compass.png"), None);
        let pointer = Texture::new(include_bytes!("pointer.png"), None);

        let camera_info = CameraInfo::new(pointers);

        MapViewer { compass, pointer, camera_info, prev_size: None, dir: 0.0, visible: false }
    }
}

impl MapViewer {
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

    pub fn render(&mut self, ui: &imgui::Ui) {
        let size = ui.io().display_size;
        let scale = size[1] / REFERENCE_HEIGHT;

        if self.prev_size != Some(size) {
            let c = COMPASS_SIZE * scale;
            let p = POINTER_SIZE * scale;
            self.compass.resize(c, c);
            self.pointer.resize(p, p);

            self.prev_size = Some(size);
        }

        if !self.visible {
            return;
        }

        let compass_x = size[0] - (RIGHT + COMPASS_HSIZE) * scale;
        let compass_y = (TOP + COMPASS_HSIZE) * scale;
        let pointer_x = size[0] - (RIGHT + COMPASS_HSIZE) * scale;
        let pointer_y = (TOP + COMPASS_HSIZE + POINTER_OFFSET) * scale;
        self.compass.render(ui, [compass_x, compass_y]);
        self.pointer.render_rotate(ui, [pointer_x, pointer_y], self.dir);
    }
}
