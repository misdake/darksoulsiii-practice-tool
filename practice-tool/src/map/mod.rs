use std::io::Cursor;

use hudhook::RenderContext;
use image::io::Reader;
use image::{EncodableLayout, RgbaImage};
use imgui::{Condition, Context, Image, TextureId};

pub struct MapViewer {
    image: RgbaImage,
    image_id: Option<TextureId>,
}

impl MapViewer {
    pub fn new() -> Self {
        let image = Reader::new(Cursor::new(include_bytes!("../../../lib//data/thingken.webp")))
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap()
            .into_rgba8();

        MapViewer { image, image_id: None }
    }
}

impl Default for MapViewer {
    fn default() -> Self {
        Self::new()
    }
}

impl MapViewer {
    pub fn before_render<'a>(
        &'a mut self,
        _ctx: &mut Context,
        render_context: &'a mut dyn RenderContext,
    ) {
        if self.image_id.is_none() {
            self.image_id = render_context
                .load_texture(
                    self.image.as_bytes(),
                    self.image.width() as _,
                    self.image.height() as _,
                )
                .ok();

            println!("{:?}", self.image_id);
        }
    }

    pub fn render(&mut self, ui: &imgui::Ui) {
        ui.window("Hello Map")
            .size([368.0, 568.0], Condition::FirstUseEver)
            .position([16.0, 16.0], Condition::FirstUseEver)
            .build(|| {
                ui.text("Hello!");

                if let Some(tex_id) = self.image_id {
                    Image::new(tex_id, [self.image.width() as f32, self.image.height() as f32])
                        .build(ui);
                }
            });
    }
}
