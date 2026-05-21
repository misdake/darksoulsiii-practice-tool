use std::io::Cursor;

use hudhook::tracing::warn;
use hudhook::RenderContext;
use image::io::Reader;
use image::{EncodableLayout, RgbaImage};
use imgui::TextureId;
use crate::util;

pub struct Texture {
    source: RgbaImage,
    image_id: Option<TextureId>,
    upload_failed_logged: bool,
    // resized in render
    width: f32,
    height: f32,
}

impl Texture {
    pub fn new(buffer: &[u8], size: Option<[u32; 2]>) -> Self {
        let source = Reader::new(Cursor::new(buffer))
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap()
            .into_rgba8();

        let [width, height] = if let Some([width, height]) = size {
            [width, height]
        } else {
            [source.width(), source.height()]
        };

        Texture {
            source,
            image_id: None,
            upload_failed_logged: false,
            width: width as f32,
            height: height as f32,
        }
    }

    pub fn prepare(&mut self, renderer: &mut dyn RenderContext) {
        if self.image_id.is_none() {
            match renderer.load_texture(self.source.as_bytes(), self.source.width(), self.source.height()) {
                Ok(id) => {
                    self.image_id = Some(id);
                    self.upload_failed_logged = false;
                },
                Err(e) => {
                    if !self.upload_failed_logged {
                        warn!(
                            "Texture upload failed ({}x{}): {:?}",
                            self.source.width(),
                            self.source.height(),
                            e
                        );
                        util::append_log_line(&format!(
                            "texture upload failed: {}x{} err={:?}",
                            self.source.width(),
                            self.source.height(),
                            e
                        ));
                        self.upload_failed_logged = true;
                    }
                },
            }
        }
    }

    pub fn resize(&mut self, width: f32, height: f32) {
        self.width = width;
        self.height = height;
    }

    fn calc_quad(
        &self,
        center_position: [f32; 2],
        rotate: f32,
    ) -> ([f32; 2], [f32; 2], [f32; 2], [f32; 2]) {
        let hw = self.width / 2.;
        let hh = self.height / 2.;
        let (sin, cos) = rotate.sin_cos();
        let cx = center_position[0];
        let cy = center_position[1];
        let p1 = [cx - cos * hw + sin * hh, cy - sin * hw - cos * hh];
        let p2 = [cx + cos * hh + sin * hw, cy + sin * hh - cos * hw];
        let p3 = [cx + cos * hw - sin * hh, cy + sin * hw + cos * hh];
        let p4 = [cx - cos * hh - sin * hw, cy - sin * hh + cos * hw];
        (p1, p2, p3, p4)
    }

    pub fn render_rotate(
        &self,
        list: &imgui::DrawListMut<'_>,
        center_position: [f32; 2],
        rotate: f32,
    ) {
        let Some(image_id) = self.image_id else {
            return;
        };
        let (p1, p2, p3, p4) = self.calc_quad(center_position, rotate);
        list.add_image_quad(image_id, p1, p2, p3, p4).build();
    }

    pub fn render_rect(&self, list: &imgui::DrawListMut<'_>, rect: [f32; 4]) {
        let Some(image_id) = self.image_id else {
            return;
        };
        list.add_image(image_id, [rect[0], rect[1]], [rect[2], rect[3]]).build();
    }

    #[allow(unused)]
    pub fn render_rotate_rect_clip(
        &self,
        _ui: &imgui::Ui,
        list: &imgui::DrawListMut<'_>,
        center_position: [f32; 2],
        rect: [f32; 4],
        rotate: f32,
    ) {
        let Some(image_id) = self.image_id else {
            return;
        };
        list.with_clip_rect([rect[0], rect[1]], [rect[2], rect[3]], || {
            let (p1, p2, p3, p4) = self.calc_quad(center_position, rotate);
            list.add_image_quad(image_id, p1, p2, p3, p4).build();
        });
    }

    #[allow(unused)]
    pub fn render_circle_clip(
        &self,
        _ui: &imgui::Ui,
        list_mut: &imgui::DrawListMut<'_>,
        center_position: [f32; 2],
        circle_position: [f32; 2],
        circle_radius: f32,
    ) {
        let Some(image_id) = self.image_id else {
            return;
        };
        let [circle_x, circle_y] = circle_position;
        let r = circle_radius;
        let circle_left = circle_x - r;
        let circle_right = circle_x + r;
        let circle_top = circle_y - r;
        let circle_bottom = circle_y + r;

        let hw = self.width / 2.;
        let hh = self.height / 2.;
        let image_left = center_position[0] - hw;
        let image_right = center_position[0] + hw;
        let image_top = center_position[1] - hh;
        let image_bottom = center_position[1] + hh;

        let left = (circle_left - image_left) / (image_right - image_left);
        let right = (circle_right - image_left) / (image_right - image_left);
        let top = (circle_top - image_top) / (image_bottom - image_top);
        let bottom = (circle_bottom - image_top) / (image_bottom - image_top);

        list_mut
            .add_image_rounded(
                image_id,
                [circle_x - r, circle_y - r],
                [circle_x + r, circle_y + r],
                circle_radius,
            )
            .uv_min([left, top])
            .uv_max([right, bottom])
            .round_all(true)
            .build();
    }
}
