use std::sync::atomic::{AtomicBool, Ordering};

use hudhook::{eject, ImguiRenderLoop, RenderContext};
use imgui::{Condition, Context, Key, StyleVar, WindowFlags};
use libds3::pointers::PointerChains;

use crate::camera_info::CameraInfo;

pub(crate) static BLOCK_XINPUT: AtomicBool = AtomicBool::new(false);

pub(crate) struct Probe {
    camera_info: CameraInfo,
    show_ui: bool,
    show_inject_hint: bool,
}

impl Probe {
    pub(crate) fn new() -> Self {
        let pointers = PointerChains::new();
        let camera_info = CameraInfo::new(&pointers);

        Probe { camera_info, show_ui: false, show_inject_hint: true }
    }
}

impl ImguiRenderLoop for Probe {
    fn before_render(&mut self, _ctx: &mut Context, _r: &mut dyn RenderContext) {
        self.camera_info.update();
    }

    fn render(&mut self, ui: &mut imgui::Ui) {
        if ui.is_key_pressed(Key::F9) {
            self.show_ui = !self.show_ui;
            self.show_inject_hint = false;
        }

        if self.show_inject_hint {
            ui.window("DS3 Map Probe")
                .size([320.0, 70.0], Condition::Always)
                .position([20.0, 20.0], Condition::Always)
                .flags(WindowFlags::NO_COLLAPSE | WindowFlags::NO_RESIZE | WindowFlags::NO_MOVE)
                .build(|| {
                    ui.text("Probe injected successfully.");
                    ui.text("Press F9 to open/close probe UI.");
                });
        }

        if !self.show_ui {
            BLOCK_XINPUT.store(false, Ordering::SeqCst);
            return;
        }

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

                if !self.camera_info.ui_pointers_available() {
                    if ui.small_button("Eject") {
                        self.show_ui = false;
                        BLOCK_XINPUT.store(false, Ordering::SeqCst);
                        eject();
                    }
                    ui.text("Required camera pointers unavailable.");
                    return;
                }

                let mut free_camera = self.camera_info.free_camera_enabled().unwrap_or(false);
                if ui.checkbox("Free Camera", &mut free_camera) {
                    self.camera_info.set_free_camera_enabled(free_camera);
                }

                if !free_camera {
                    if ui.small_button("Eject") {
                        self.show_ui = false;
                        BLOCK_XINPUT.store(false, Ordering::SeqCst);
                        eject();
                    }
                    ui.text("Free Camera disabled (0).");
                    return;
                }

                if let Some(render_state) = self.camera_info.camera_render_state() {
                    let mut fovy_rad = render_state.fov;
                    if ui.input_float("Fovy (rad)", &mut fovy_rad).build()
                        && fovy_rad > 0.1
                        && fovy_rad < 2.
                    {
                        self.camera_info.set_fovy_rad(fovy_rad);
                    }

                    let qx = render_state.quat_x;
                    let [qy, qz, qt] = render_state.quat_yzt;
                    ui.text(format!(
                        "Camera Quat [x,y,z,t]: {:.6}, {:.6}, {:.6}, {:.6}",
                        qx, qy, qz, qt
                    ));

                    if ui.button("Set Vertical Down (Y-)") {
                        self.camera_info.set_quat([-1.0, 0.0, -1.0, 0.0]);
                    }
                } else {
                    ui.text("Camera render state: N/A");
                }

                match self.camera_info.player_position() {
                    Some([x, y, z]) => {
                        ui.text(format!("Player Position: {x:.3}, {y:.3}, {z:.3}"));
                    },
                    None => ui.text("Player Position: N/A"),
                }

                match self.camera_info.camera_position() {
                    Some([x, y, z]) => {
                        ui.text(format!("Camera Position: {x:.3}, {y:.3}, {z:.3}"));
                    },
                    None => ui.text("Camera Position: N/A"),
                }

                if ui.small_button("Eject") {
                    self.show_ui = false;
                    BLOCK_XINPUT.store(false, Ordering::SeqCst);
                    eject();
                }
            });

        BLOCK_XINPUT
            .store(ui.io().want_capture_mouse || ui.io().want_capture_keyboard, Ordering::SeqCst);
    }
}
