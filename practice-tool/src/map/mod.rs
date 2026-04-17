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

    direction_offset_degrees: f32,
    size_scale: f32,
    dir: f32,
    visible: bool,
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
    pub fn is_enabled(&self) -> bool {
        self.visible
    }

    pub fn player_position(&self) -> Option<[f32; 3]> {
        self.camera_info.player_position()
    }

    pub fn camera_position(&self) -> Option<[f32; 3]> {
        self.camera_info.camera_position()
    }

    pub fn direction_offset_degrees(&self) -> f32 {
        self.direction_offset_degrees
    }

    pub fn size_scale(&self) -> f32 {
        self.size_scale
    }

    pub fn set_direction_offset_degrees(&mut self, value: f32) {
        self.direction_offset_degrees = value;
    }

    pub fn set_size_scale(&mut self, value: f32) {
        self.size_scale = value.max(0.1);
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

    pub fn render(&mut self, ui: &imgui::Ui) {
        let size = ui.io().display_size;
        let base_scale = size[1] / REFERENCE_HEIGHT;
        let scale = base_scale * self.size_scale;

        let c = COMPASS_SIZE * scale;
        let p = POINTER_SIZE * scale;
        self.compass.resize(c, c);
        self.pointer.resize(p, p);

        if !self.visible {
            return;
        }

        let compass_hsize = COMPASS_HSIZE * scale;
        let compass_x = size[0] - RIGHT * base_scale - compass_hsize;
        let compass_y = TOP * base_scale + compass_hsize;
        let pointer_x = compass_x;
        let pointer_y = compass_y + POINTER_OFFSET * scale;
        let direction_offset = self.direction_offset_degrees.to_radians();
        self.compass.render(ui, [compass_x, compass_y]);
        self.pointer.render_rotate(ui, [pointer_x, pointer_y], self.dir + direction_offset);
    }
}
