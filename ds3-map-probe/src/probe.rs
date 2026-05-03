use std::sync::atomic::{AtomicBool, Ordering};

use hudhook::{ImguiRenderLoop, RenderContext};
use imgui::{Condition, Context, StyleVar, WindowFlags};
use libds3::pointers::PointerChains;

use crate::camera_info::CameraInfo;

pub(crate) static BLOCK_XINPUT: AtomicBool = AtomicBool::new(false);

pub(crate) struct Probe {
    camera_info: CameraInfo,
}

impl Probe {
    pub(crate) fn new() -> Self {
        let pointers = PointerChains::new();
        let camera_info = CameraInfo::new(&pointers);

        Probe { camera_info }
    }
}

impl ImguiRenderLoop for Probe {
    fn before_render(&mut self, _ctx: &mut Context, _r: &mut dyn RenderContext) {
        self.camera_info.update();
    }

    fn render(&mut self, ui: &mut imgui::Ui) {
        let _style_tokens = [
            ui.push_style_var(StyleVar::WindowRounding(0.0)),
            ui.push_style_var(StyleVar::WindowBorderSize(0.0)),
        ];

        ui.window("DS3 Map Data Collector")
            .size([420.0, 220.0], Condition::FirstUseEver)
            .position([20.0, 20.0], Condition::FirstUseEver)
            .flags(WindowFlags::NO_COLLAPSE)
            .build(|| {
                ui.text("PointerChains / Camera Data");
                ui.separator();

                ui.text(format!(
                    "In game (smoothed): {}",
                    self.camera_info.in_game_estimated()
                ));

                match self.camera_info.player_position() {
                    Some([x, y, z]) => {
                        ui.text(format!("Player Position: {x:.3}, {y:.3}, {z:.3}"));
                    },
                    None => ui.text("Player Position: N/A"),
                }

                match self.camera_info.camera_position_global() {
                    Some([x, y, z]) => {
                        ui.text(format!("Global Camera Position: {x:.3}, {y:.3}, {z:.3}"));
                    },
                    None => ui.text("Global Camera Position: N/A"),
                }

                match self.camera_info.camera_position_follow() {
                    Some([x, y, z]) => {
                        ui.text(format!("Follow Camera Position: {x:.3}, {y:.3}, {z:.3}"));
                    },
                    None => ui.text("Follow Camera Position: N/A"),
                }

                match self.camera_info.camera_angle_follow() {
                    Some([x, y]) => {
                        ui.text(format!("Camera Angle Follow: {x:.6}, {y:.6}"));
                    },
                    None => ui.text("Camera Angle Follow: N/A"),
                }
            });

        BLOCK_XINPUT.store(ui.io().want_capture_mouse || ui.io().want_capture_keyboard, Ordering::SeqCst);
    }
}
