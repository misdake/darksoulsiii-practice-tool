use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use hudhook::{eject, ImguiRenderLoop, RenderContext};
use imgui::{Condition, Context, Key, StyleVar, WindowFlags};
use libds3::pointers::PointerChains;

use crate::camera_info::CameraInfo;
use crate::capture_files::{self, CaptureContext};
use crate::util;

pub(crate) static BLOCK_XINPUT: AtomicBool = AtomicBool::new(false);

pub(crate) struct Probe {
    pointers: PointerChains,
    camera_info: CameraInfo,
    exe_path: Option<String>,
    capture_root: PathBuf,
    capture_subdir: String,
    capture_status: String,
    show_ui: bool,
    show_inject_hint: bool,
}

impl Probe {
    pub(crate) fn new() -> Self {
        let pointers = PointerChains::new();
        let camera_info = CameraInfo::new(&pointers);
        let exe_path = util::get_exe_path().map(|p| p.to_string_lossy().into_owned());
        let capture_root = exe_path
            .as_deref()
            .and_then(|p| PathBuf::from(p).parent().map(|dir| dir.join("capture")))
            .or_else(|| std::env::current_dir().ok().map(|dir| dir.join("capture")))
            .unwrap_or_else(|| PathBuf::from(".").join("capture"));
        let _ = std::fs::create_dir_all(&capture_root);

        Probe {
            pointers,
            camera_info,
            exe_path,
            capture_root,
            capture_subdir: "default".to_string(),
            capture_status: String::new(),
            show_ui: false,
            show_inject_hint: true,
        }
    }

    fn set_ui_visibility(&mut self, show: bool) {
        self.pointers.cursor_show.set(show);
        self.show_ui = show;
    }

    fn reset_free_camera(&self) {
        self.camera_info.set_camera_position_from_player_offset([0.0, 10.0, 0.0]);
        self.camera_info.set_quat([
            -std::f32::consts::FRAC_1_SQRT_2,
            0.0,
            -std::f32::consts::FRAC_1_SQRT_2,
            0.0,
        ]);
    }

    fn process_capture_files(&mut self) {
        let Some(exe_path) = &self.exe_path else {
            self.capture_status = "Capture failed: EXE path unavailable.".to_string();
            return;
        };

        let game_dir = PathBuf::from(exe_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let subdir = self.capture_subdir.trim();
        if subdir.is_empty() {
            self.capture_status = "Capture failed: subfolder name is empty.".to_string();
            return;
        }
        let output_dir = self.capture_root.join(subdir);

        let ctx = CaptureContext {
            player_position: self.camera_info.player_position(),
            camera_position: self.camera_info.camera_position(),
            camera_render_state: self.camera_info.camera_render_state(),
        };

        match capture_files::process_latest_capture(&game_dir, &output_dir, &ctx) {
            Ok(_) => self.capture_status.clear(),
            Err(err) => self.capture_status = format!("Capture failed: {err}"),
        }
    }
}

impl ImguiRenderLoop for Probe {
    fn before_render(&mut self, _ctx: &mut Context, _r: &mut dyn RenderContext) {
        self.camera_info.update();
    }

    fn render(&mut self, ui: &mut imgui::Ui) {
        if ui.is_key_pressed(Key::F9) {
            self.set_ui_visibility(!self.show_ui);
            self.show_inject_hint = false;
        }

        if ui.is_key_pressed(Key::F8) {
            if let Some(enabled) = self.camera_info.free_camera_enabled() {
                if enabled {
                    self.camera_info.set_free_camera_enabled(false);
                } else {
                    self.reset_free_camera();
                    self.camera_info.set_free_camera_enabled(true);
                }
            }
        }

        if ui.is_key_pressed(Key::F7) {
            self.reset_free_camera();
        }

        if ui.is_key_pressed(Key::F6) {
            self.camera_info.teleport_player_to_camera(-1.6);
        }
        if ui.is_key_pressed(Key::F11) {
            self.process_capture_files();
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
                if ui.small_button("Eject") {
                    self.set_ui_visibility(false);
                    BLOCK_XINPUT.store(false, Ordering::SeqCst);
                    eject();
                }

                ui.separator();
                ui.text_wrapped(format!("Capture Root: {}", self.capture_root.display()));
                ui.text("Capture Subfolder:");
                ui.input_text("##capture_subdir", &mut self.capture_subdir).build();
                if ui.button("Process Latest Capture Pair (F11)") {
                    self.process_capture_files();
                }
                if !self.capture_status.is_empty() {
                    ui.text_wrapped(&self.capture_status);
                }
                ui.separator();

                if !self.camera_info.ui_pointers_available() {
                    ui.text("Required camera pointers unavailable.");
                    return;
                }

                let free_camera = self.camera_info.free_camera_enabled().unwrap_or(false);
                if free_camera {
                    ui.text("Free Camera: Enabled (toggle with F8)");
                } else {
                    ui.text("Free Camera: Disabled (toggle with F8)");
                }

                let mut ai_disable = self.pointers.ai_disable.get().unwrap_or(false);
                if ui.checkbox("AI Disable", &mut ai_disable) {
                    self.pointers.ai_disable.set(ai_disable);
                }

                let mut all_no_damage = self.pointers.all_no_damage.get().unwrap_or(false);
                if ui.checkbox("All No Damage", &mut all_no_damage) {
                    self.pointers.all_no_damage.set(all_no_damage);
                }

                let mut render_chr = self.pointers.rend_chr.get().unwrap_or(false);
                if ui.checkbox("Render Character", &mut render_chr) {
                    self.pointers.rend_chr.set(render_chr);
                }

                if ui.button("Reset Free Camera (F7)") {
                    self.reset_free_camera();
                }
                ui.same_line();
                if ui.button("Teleport Player To Camera (F6)") {
                    self.camera_info.teleport_player_to_camera(-1.6);
                }

                if !free_camera {
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

                    let mut near = render_state.near;
                    let mut far = render_state.far;
                    let near_changed = ui.input_float("Near", &mut near).build();
                    let far_changed = ui.input_float("Far", &mut far).build();
                    if (near_changed || far_changed) && !self.camera_info.set_near_far(near, far) {
                        ui.text("Invalid range: require 0.001 < near < far < 100000.");
                    }

                    let qw = render_state.quat_w;
                    let [qx, qy, qz] = render_state.quat_xyz;
                    ui.text(format!(
                        "Camera Quat [w,x,y,z]: {:.3}, {:.3}, {:.3}, {:.3}",
                        qw, qx, qy, qz
                    ));
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
            });

        BLOCK_XINPUT
            .store(ui.io().want_capture_mouse || ui.io().want_capture_keyboard, Ordering::SeqCst);
    }
}
