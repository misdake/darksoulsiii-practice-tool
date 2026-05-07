use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use ds3_depthbuffer::{
    dot3, normalize3, read_depth_exr_first_channel, unproject_center_to_world, CameraProjection,
    ImageSize,
};
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
    auto_near_far_offset: f32,
    auto_near_far_range: f32,
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
            auto_near_far_offset: 0.0,
            auto_near_far_range: 3.0,
        }
    }

    fn set_ui_visibility(&mut self, show: bool) {
        self.pointers.cursor_show.set(show);
        self.show_ui = show;
    }

    fn reset_free_camera(&self) {
        self.camera_info.set_camera_position_from_player_offset([0.0, 10.0, 0.0]);
        // Top-down view: look toward Y-, with up set to Z- for stable roll.
        self.camera_info.set_camera_up_dir([0.0, 0.0, -1.0], [0.0, -1.0, 0.0]);
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

    fn toggle_player_visibility_flag(&mut self) {
        let current = self.pointers.rend_chr.get().unwrap_or(false);
        self.pointers.rend_chr.set(!current);
    }

    fn nudge_near_far(&self, near_delta: f32, far_delta: f32) {
        if let Some(state) = self.camera_info.camera_render_state() {
            let near = state.near + near_delta;
            let far = state.far + far_delta;
            let _ = self.camera_info.set_near_far(near, far);
        }
    }

    fn set_near_far_around_player_depth(&mut self) {
        let Some(player) = self.camera_info.player_position() else {
            self.capture_status = "Auto near/far failed: player position unavailable.".to_string();
            return;
        };
        let Some(camera) = self.camera_info.camera_position() else {
            self.capture_status = "Auto near/far failed: camera position unavailable.".to_string();
            return;
        };
        let Some(state) = self.camera_info.camera_render_state() else {
            self.capture_status =
                "Auto near/far failed: camera render state unavailable.".to_string();
            return;
        };

        let dir = normalize3(state.camera_dir);
        let to_player = [player[0] - camera[0], player[1] - camera[1], player[2] - camera[2]];
        let player_depth = dot3(to_player, dir);

        let offset = self.auto_near_far_offset.clamp(-2.0, 2.0);
        let range = self.auto_near_far_range.clamp(0.0, 10.0);
        let center = player_depth + offset;
        let near = center - range;
        let far = center + range;

        if self.camera_info.set_near_far(near, far) {
            self.capture_status.clear();
        } else {
            self.capture_status = format!(
                "Auto near/far failed: near={near:.3}, far={far:.3} invalid (need 0.001 < near < far)."
            );
        }
    }

    fn teleport_player_from_latest_depth_center(&mut self) {
        let Some(exe_path) = &self.exe_path else {
            self.capture_status = "F12 failed: EXE path unavailable.".to_string();
            return;
        };
        let game_dir = PathBuf::from(exe_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        let Some((rgb_path, depth_path)) = find_latest_capture_pair(&game_dir) else {
            self.capture_status =
                "F12 failed: no rgb/depth pair found in game directory.".to_string();
            return;
        };

        let Some(state) = self.camera_info.camera_render_state() else {
            self.capture_status = "F12 failed: camera render state unavailable.".to_string();
            return;
        };

        let depth_map = match read_depth_exr_first_channel(&depth_path).map_err(|e| e.to_string()) {
            Ok(v) => v,
            Err(e) => {
                self.capture_status = format!("F12 failed: read exr: {e}");
                return;
            },
        };
        let Some(depth01) = sample_center_depth(&depth_map.0, depth_map.1, depth_map.2) else {
            self.capture_status = "F12 failed: no finite center depth found.".to_string();
            return;
        };

        let world = unproject_center_to_world(
            depth01,
            ImageSize { width: depth_map.1, height: depth_map.2 },
            &CameraProjection {
                fov_y_rad: state.fov,
                near: state.near,
                far: state.far,
                camera_up: state.camera_up,
                camera_dir: state.camera_dir,
                camera_position: state.position,
            },
        );
        let target = [world[0], world[1] + 2.0, world[2]];
        self.camera_info.set_player_position(target);

        let _ = fs::remove_file(&rgb_path);
        let _ = fs::remove_file(&depth_path);
        self.capture_status = format!(
            "F12: moved player to [{:.3}, {:.3}, {:.3}] and deleted latest pair.",
            target[0], target[1], target[2]
        );
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
            self.toggle_player_visibility_flag();
        }
        if ui.is_key_pressed(Key::F11) {
            self.process_capture_files();
        }
        if ui.is_key_pressed(Key::F12) {
            self.teleport_player_from_latest_depth_center();
        }
        if ui.is_key_pressed(Key::F5) {
            self.set_near_far_around_player_depth();
        }
        if ui.is_key_pressed(Key::Minus) {
            self.nudge_near_far(-1.0, 0.0);
        }
        if ui.is_key_pressed(Key::Equal) {
            self.nudge_near_far(1.0, 0.0);
        }
        if ui.is_key_pressed(Key::LeftBracket) {
            self.nudge_near_far(0.0, -1.0);
        }
        if ui.is_key_pressed(Key::RightBracket) {
            self.nudge_near_far(0.0, 1.0);
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
                if ui.button("Toggle Player Visibility (F6)") {
                    self.toggle_player_visibility_flag();
                }
                if ui.button("Teleport Player To Latest Depth Center + Delete Pair (F12)") {
                    self.teleport_player_from_latest_depth_center();
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
                    ui.text("Hotkeys: '-'/'=' nudge Near, '['/']' nudge Far");
                    ui.text("F5: auto set Near/Far around player depth");
                    ui.slider_config("Auto Offset", -2.0, 2.0)
                        .build(&mut self.auto_near_far_offset);
                    ui.slider_config("Auto Range", 0.0, 10.0).build(&mut self.auto_near_far_range);

                    ui.text(format!(
                        "Camera Up [x,y,z]: {:.3}, {:.3}, {:.3}",
                        render_state.camera_up[0],
                        render_state.camera_up[1],
                        render_state.camera_up[2]
                    ));
                    ui.text(format!(
                        "Camera Dir [x,y,z]: {:.3}, {:.3}, {:.3}",
                        render_state.camera_dir[0],
                        render_state.camera_dir[1],
                        render_state.camera_dir[2]
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

fn find_latest_capture_pair(game_dir: &std::path::Path) -> Option<(PathBuf, PathBuf)> {
    let mut best: Option<(i64, PathBuf, PathBuf)> = None;
    let mut groups: std::collections::HashMap<String, (Option<PathBuf>, Option<PathBuf>, i64)> =
        std::collections::HashMap::new();

    for entry in fs::read_dir(game_dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(v) => v,
            None => continue,
        };
        let (prefix, is_rgb, is_depth) = if let Some(prefix) = name.strip_suffix(" BackBuffer.bmp")
        {
            (prefix.to_string(), true, false)
        } else if let Some(prefix) = name.strip_suffix(" DepthBuffer.exr") {
            (prefix.to_string(), false, true)
        } else {
            continue;
        };
        let mtime = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let slot = groups.entry(prefix).or_insert((None, None, mtime));
        if is_rgb {
            slot.0 = Some(path);
        } else if is_depth {
            slot.1 = Some(path);
        }
        slot.2 = slot.2.max(mtime);
    }

    for (_, (rgb, depth, ts)) in groups {
        let (Some(rgb), Some(depth)) = (rgb, depth) else {
            continue;
        };
        match &best {
            Some((best_ts, _, _)) if *best_ts >= ts => {},
            _ => best = Some((ts, rgb, depth)),
        }
    }
    best.map(|(_, rgb, depth)| (rgb, depth))
}

fn sample_center_depth(depth: &[f32], w: usize, h: usize) -> Option<f32> {
    if w == 0 || h == 0 {
        return None;
    }
    let cx = (w / 2) as i32;
    let cy = (h / 2) as i32;
    let mut vals = Vec::new();
    for oy in -2..=2 {
        for ox in -2..=2 {
            let x = cx + ox;
            let y = cy + oy;
            if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
                continue;
            }
            let v = depth[y as usize * w + x as usize];
            if v.is_finite() {
                vals.push(v);
            }
        }
    }
    if vals.is_empty() {
        return None;
    }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(vals[vals.len() / 2].clamp(0.0, 1.0))
}
