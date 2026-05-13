use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use std::time::Instant;
use std::time::UNIX_EPOCH;

use ds3_depthbuffer::{
    read_depth_exr_first_channel, unproject_center_to_world, CameraProjection, ImageSize,
};
use hudhook::{eject, ImguiRenderLoop, RenderContext};
use imgui::{Condition, Context, Key, StyleVar, WindowFlags};
use libds3::pointers::PointerChains;
use serde::{Deserialize, Serialize};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_F10,
};

use crate::camera_info::CameraInfo;
use crate::capture_files::{self, CaptureContext};
use crate::coord_space::{convert_z, parse_coord_space, CoordSpace};
use crate::util;

pub(crate) static BLOCK_XINPUT: AtomicBool = AtomicBool::new(false);

const LOOP_CLOSE_DISTANCE: f32 = 2.0;
const LOOP_SAMPLE_EPS: f32 = 1.0e-3;
const RESHADE_HOTKEY_HOLD_MS: u64 = 110;
const DEFAULT_SUBDIR_PRESETS: &str = include_str!("../data/probe_subfolder_presets.txt");

#[derive(Clone, Copy, PartialEq, Eq)]
enum ShotRunnerState {
    Idle,
    WaitLoad,
    WaitConfirm,
    WaitShot,
}

#[derive(Serialize, Deserialize)]
struct TrajectoryFile {
    coord_space: String,
    version: u32,
    close_distance: f32,
    loops: Vec<Vec<[f32; 3]>>,
    polylines: Vec<Vec<[f32; 3]>>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ShotConfig {
    #[serde(alias = "screen_width")]
    render_width: u32,
    #[serde(alias = "screen_height")]
    render_height: u32,
    #[serde(default = "default_shot_fov")]
    fov_y_rad: f32,
    base_ratio_px_per_wu: f32,
    density_multiplier: f32,
    overlap_ratio: f32,
    polyline_buffer_world: f32,
    y_neighbor_k: usize,
    y_lift: f32,
    wait_load_ms: u64,
    wait_shot_ms: u64,
}

fn default_shot_fov() -> f32 {
    0.9
}

impl Default for ShotConfig {
    fn default() -> Self {
        Self {
            render_width: 2560,
            render_height: 1440,
            fov_y_rad: default_shot_fov(),
            base_ratio_px_per_wu: 32.0,
            density_multiplier: 2.0,
            overlap_ratio: 0.5,
            polyline_buffer_world: 2.0,
            y_neighbor_k: 5,
            y_lift: 2.0,
            wait_load_ms: 500,
            wait_shot_ms: 1000,
        }
    }
}

#[derive(Deserialize)]
struct ShotPointsFile {
    coord_space: String,
    points: Vec<ShotPoint>,
    #[serde(default)]
    wait_load_ms: Option<u64>,
    #[serde(default)]
    wait_shot_ms: Option<u64>,
    #[serde(default)]
    fov_y_rad: Option<f32>,
}

#[derive(Deserialize)]
struct ShotPoint {
    x: f32,
    y: f32,
    z: f32,
}

pub(crate) struct Probe {
    pointers: PointerChains,
    camera_info: CameraInfo,
    exe_path: Option<String>,
    capture_root: PathBuf,
    capture_subdir: String,
    capture_subdir_presets: Vec<String>,
    capture_status: String,
    show_ui: bool,
    show_inject_hint: bool,
    reshade_hotkey_up_due_at: Option<Instant>,
    loop_recording: bool,
    current_path: Vec<[f32; 3]>,
    closed_loops: Vec<Vec<[f32; 3]>>,
    polylines: Vec<Vec<[f32; 3]>>,
    shot_config: ShotConfig,
    show_shot_config_window: bool,
    show_trajectory_window: bool,
    shot_points: Vec<[f32; 3]>,
    shot_trajectory_points: Vec<[f32; 3]>,
    shot_idx: usize,
    shot_running: bool,
    shot_state: ShotRunnerState,
    shot_state_due: Option<Instant>,
    shot_advance_after_capture: bool,
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
        let capture_subdir_presets = parse_subdir_presets(DEFAULT_SUBDIR_PRESETS);

        Probe {
            pointers,
            camera_info,
            exe_path,
            capture_root,
            capture_subdir: "default".to_string(),
            capture_subdir_presets,
            capture_status: String::new(),
            show_ui: false,
            show_inject_hint: true,
            reshade_hotkey_up_due_at: None,
            loop_recording: false,
            current_path: Vec::new(),
            closed_loops: Vec::new(),
            polylines: Vec::new(),
            shot_config: ShotConfig::default(),
            show_shot_config_window: false,
            show_trajectory_window: false,
            shot_points: Vec::new(),
            shot_trajectory_points: Vec::new(),
            shot_idx: 0,
            shot_running: false,
            shot_state: ShotRunnerState::Idle,
            shot_state_due: None,
            shot_advance_after_capture: true,
        }
    }

    fn output_dir(&self) -> Option<PathBuf> {
        let subdir = self.capture_subdir.trim();
        if subdir.is_empty() {
            return None;
        }
        Some(self.capture_root.join(subdir))
    }

    fn set_ui_visibility(&mut self, show: bool) {
        self.pointers.cursor_show.set(show);
        self.show_ui = show;
    }

    fn infer_render_size_from_latest_capture(&self) -> Option<(usize, usize)> {
        let exe_path = self.exe_path.as_deref()?;
        let game_dir = PathBuf::from(exe_path).parent()?.to_path_buf();
        let (_, depth_path) = find_latest_capture_pair(&game_dir)?;
        let (_, w, h) = read_depth_exr_first_channel(&depth_path).ok()?;
        Some((w, h))
    }

    fn refresh_shot_config_fov_from_memory(&mut self) {
        if let Some(state) = self.camera_info.camera_render_state() {
            self.shot_config.fov_y_rad = state.fov;
        }
    }

    fn reset_free_camera(&self) {
        self.camera_info
            .set_camera_position_from_player_offset([0.0, 20.0, 0.0]);
        self.camera_info.set_camera_up_dir([0.0, 0.0, -1.0], [0.0, -1.0, 0.0]);
        let _ = self.camera_info.set_near_far(10.0, 100.0);
    }

    fn process_capture_files(&mut self) {
        let Some(exe_path) = &self.exe_path else {
            self.capture_status = "Capture failed: EXE path unavailable.".to_string();
            return;
        };
        let Some(output_dir) = self.output_dir() else {
            self.capture_status = "Capture failed: subfolder name is empty.".to_string();
            return;
        };
        let game_dir = PathBuf::from(exe_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

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

    fn toggle_loop_recording(&mut self) {
        self.loop_recording = !self.loop_recording;
        if self.loop_recording {
            self.current_path.clear();
            self.capture_status = "Trajectory recording started (F1).".to_string();
        } else {
            self.capture_status = "Trajectory recording stopped (F1).".to_string();
        }
    }

    fn update_loop_recording(&mut self) {
        if !self.loop_recording {
            return;
        }
        let Some(p) = self.camera_info.player_position() else {
            return;
        };
        if let Some(last) = self.current_path.last().copied() {
            let dx = p[0] - last[0];
            let dy = p[1] - last[1];
            let dz = p[2] - last[2];
            if (dx * dx + dy * dy + dz * dz) <= LOOP_SAMPLE_EPS * LOOP_SAMPLE_EPS {
                return;
            }
        }
        self.current_path.push(p);
    }

    fn close_current_loop(&mut self) {
        if self.current_path.len() < 3 {
            self.capture_status = "Close failed: need at least 3 points.".to_string();
            return;
        }
        let first = self.current_path[0];
        let last = *self.current_path.last().unwrap_or(&first);
        let dx = last[0] - first[0];
        let dz = last[2] - first[2];
        let d = (dx * dx + dz * dz).sqrt();
        if d > LOOP_CLOSE_DISTANCE {
            self.capture_status =
                format!("Close failed: start/end too far ({:.2} > {:.2}).", d, LOOP_CLOSE_DISTANCE);
            return;
        }
        let mut loop_pts = self.current_path.clone();
        if let Some(end) = loop_pts.last().copied() {
            let ex = end[0] - first[0];
            let ez = end[2] - first[2];
            if (ex * ex + ez * ez).sqrt() > LOOP_SAMPLE_EPS {
                loop_pts.push(first);
            }
        }
        self.closed_loops.push(loop_pts);
        self.current_path.clear();
        self.loop_recording = false;
        self.capture_status = format!("Loop closed. total={}", self.closed_loops.len());
    }

    fn append_current_polyline(&mut self) {
        if self.current_path.len() < 2 {
            self.capture_status = "Polyline needs at least 2 points.".to_string();
            return;
        }
        self.polylines.push(self.current_path.clone());
        self.current_path.clear();
        self.loop_recording = false;
        self.capture_status = format!("Polyline added. total={}", self.polylines.len());
    }

    fn discard_current_path(&mut self) {
        self.current_path.clear();
        self.loop_recording = false;
        self.capture_status = "Current path discarded.".to_string();
    }

    fn export_trajectory(&mut self) {
        let Some(output_dir) = self.output_dir() else {
            self.capture_status = "Export failed: subfolder name is empty.".to_string();
            return;
        };
        if let Err(e) = fs::create_dir_all(&output_dir) {
            self.capture_status = format!("Export failed: create dir: {e}");
            return;
        }
        let path = output_dir.join("trajectory.json");
        let mut merged_loops = self.closed_loops.clone();
        let mut merged_polylines = self.polylines.clone();
        if path.is_file() {
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(existing) = serde_json::from_slice::<TrajectoryFile>(&bytes) {
                    merged_loops.extend(existing.loops);
                    merged_polylines.extend(existing.polylines);
                }
            }
        }
        dedup_paths(&mut merged_loops);
        dedup_paths(&mut merged_polylines);
        let payload = TrajectoryFile {
            coord_space: CoordSpace::Game.as_str().to_string(),
            version: 1,
            close_distance: LOOP_CLOSE_DISTANCE,
            loops: merged_loops,
            polylines: merged_polylines,
        };
        match serde_json::to_vec_pretty(&payload)
            .map_err(|e| e.to_string())
            .and_then(|v| fs::write(&path, v).map_err(|e| e.to_string()))
        {
            Ok(_) => {
                self.capture_status = format!(
                    "Exported trajectory: {} (loops={}, polylines={})",
                    path.display(),
                    payload.loops.len(),
                    payload.polylines.len()
                );
            },
            Err(e) => self.capture_status = format!("Export failed: {e}"),
        }
    }

    fn clear_all_trajectories(&mut self) {
        self.closed_loops.clear();
        self.polylines.clear();
        self.capture_status = "All trajectories cleared.".to_string();
    }

    fn save_shot_config(&mut self) {
        let Some(output_dir) = self.output_dir() else {
            self.capture_status = "Save config failed: subfolder name is empty.".to_string();
            return;
        };
        if let Err(e) = fs::create_dir_all(&output_dir) {
            self.capture_status = format!("Save config failed: {e}");
            return;
        }
        self.refresh_shot_config_fov_from_memory();
        if let Some((w, h)) = self.infer_render_size_from_latest_capture() {
            self.shot_config.render_width = w as u32;
            self.shot_config.render_height = h as u32;
        }

        let path = output_dir.join("shot_config.json");
        match serde_json::to_vec_pretty(&self.shot_config)
            .map_err(|e| e.to_string())
            .and_then(|v| fs::write(&path, v).map_err(|e| e.to_string()))
        {
            Ok(_) => self.capture_status = format!("Saved shot config: {}", path.display()),
            Err(e) => self.capture_status = format!("Save config failed: {e}"),
        }
    }

    fn load_shot_config(&mut self) {
        let Some(output_dir) = self.output_dir() else {
            self.capture_status = "Load config failed: subfolder name is empty.".to_string();
            return;
        };
        let path = output_dir.join("shot_config.json");
        let bytes = match fs::read(&path) {
            Ok(v) => v,
            Err(e) => {
                self.capture_status = format!("Load config failed: {e}");
                return;
            },
        };
        match serde_json::from_slice::<ShotConfig>(&bytes) {
            Ok(v) => {
                self.shot_config = v;
                self.capture_status = format!("Loaded shot config: {}", path.display());
            },
            Err(e) => self.capture_status = format!("Load config failed: {e}"),
        }
    }

    fn load_shot_points(&mut self) {
        let Some(output_dir) = self.output_dir() else {
            self.capture_status = "Load shot points failed: subfolder name is empty.".to_string();
            return;
        };
        let path = output_dir.join("shot_points.json");
        let bytes = match fs::read(&path) {
            Ok(v) => v,
            Err(e) => {
                self.capture_status = format!("Load shot points failed: {e}");
                return;
            },
        };
        let parsed = match serde_json::from_slice::<ShotPointsFile>(&bytes) {
            Ok(v) => v,
            Err(e) => {
                self.capture_status = format!("Load shot points failed: {e}");
                return;
            },
        };
        let src_space = parse_coord_space(&parsed.coord_space);
        self.shot_points = parsed
            .points
            .iter()
            .map(|p| [p.x, p.y, convert_z(p.z, src_space, CoordSpace::Game)])
            .collect();
        self.shot_trajectory_points = load_trajectory_points(&output_dir.join("trajectory.json"));
        if let Some(ms) = parsed.wait_load_ms {
            self.shot_config.wait_load_ms = ms;
        }
        if let Some(ms) = parsed.wait_shot_ms {
            self.shot_config.wait_shot_ms = ms;
        }
        // Keep fov from live camera memory; do not override from files.
        let _ = parsed.fov_y_rad;
        self.refresh_shot_config_fov_from_memory();
        self.shot_idx = self.find_nearest_shot_index().unwrap_or(0);
        self.shot_state = ShotRunnerState::Idle;
        self.shot_running = false;
        self.capture_status =
            format!("Loaded shot points: {} (count={})", path.display(), self.shot_points.len());
    }

    fn find_nearest_shot_index(&self) -> Option<usize> {
        let player = self.camera_info.player_position()?;
        let mut best: Option<(usize, f32)> = None;
        for (i, p) in self.shot_points.iter().enumerate() {
            let dx = p[0] - player[0];
            let dy = p[1] - player[1];
            let dz = p[2] - player[2];
            let d2 = dx * dx + dy * dy + dz * dz;
            match best {
                Some((_, bd2)) if bd2 <= d2 => {},
                _ => best = Some((i, d2)),
            }
        }
        best.map(|v| v.0)
    }

    fn jump_to_shot_index(&mut self, index: usize) {
        if self.shot_points.is_empty() {
            self.capture_status = "No shot points loaded.".to_string();
            return;
        }
        self.shot_idx = index.min(self.shot_points.len().saturating_sub(1));
        self.shot_running = true;
        self.teleport_to_current_shot();
    }

    fn step_shot_index(&mut self, delta: i32) {
        if self.shot_points.is_empty() {
            self.capture_status = "No shot points loaded.".to_string();
            return;
        }
        let cur = self.shot_idx as i32;
        let max = self.shot_points.len().saturating_sub(1) as i32;
        let next = (cur + delta).clamp(0, max) as usize;
        self.shot_idx = next;
        self.shot_running = true;
        self.teleport_to_current_shot();
    }

    fn teleport_to_current_shot(&mut self) {
        if self.shot_idx >= self.shot_points.len() {
            self.shot_running = false;
            self.shot_state = ShotRunnerState::Idle;
            self.capture_status = "Shot run done.".to_string();
            return;
        }
        let p = self.shot_points[self.shot_idx];
        let player_target = nearest_point(p, &self.shot_trajectory_points).unwrap_or(p);
        self.camera_info.set_player_position(player_target);
        self.camera_info
            .set_camera_position([p[0], p[1] + 20.0, p[2]]);
        self.camera_info
            .set_camera_up_dir([0.0, 0.0, -1.0], [0.0, -1.0, 0.0]);
        self.camera_info.set_fovy_rad(self.shot_config.fov_y_rad);
        self.shot_state = ShotRunnerState::WaitLoad;
        self.shot_state_due =
            Some(Instant::now() + Duration::from_millis(self.shot_config.wait_load_ms));
        self.capture_status = format!(
            "Shot {}/{} player=[{:.2}, {:.2}, {:.2}] camera=[{:.2}, {:.2}, {:.2}]",
            self.shot_idx + 1,
            self.shot_points.len(),
            player_target[0],
            player_target[1],
            player_target[2],
            p[0],
            p[1] + 20.0,
            p[2]
        );
    }

    fn service_shot_runner(&mut self, ui: &imgui::Ui) {
        if !self.shot_running {
            return;
        }
        match self.shot_state {
            ShotRunnerState::Idle => self.teleport_to_current_shot(),
            ShotRunnerState::WaitLoad => {
                if let Some(due) = self.shot_state_due {
                    if Instant::now() >= due {
                        self.shot_state = ShotRunnerState::WaitConfirm;
                        self.shot_state_due = None;
                        self.capture_status = format!(
                            "Shot {}/{} ready. F2=capture+next, F3=capture+stay.",
                            self.shot_idx + 1,
                            self.shot_points.len()
                        );
                    }
                }
            },
            ShotRunnerState::WaitConfirm => {
                if ui.is_key_pressed(Key::F2) {
                    self.shot_advance_after_capture = true;
                    self.trigger_reshade_screenshot();
                    self.shot_state = ShotRunnerState::WaitShot;
                    self.shot_state_due =
                        Some(Instant::now() + Duration::from_millis(self.shot_config.wait_shot_ms));
                } else if ui.is_key_pressed(Key::F3) {
                    self.shot_advance_after_capture = false;
                    self.trigger_reshade_screenshot();
                    self.shot_state = ShotRunnerState::WaitShot;
                    self.shot_state_due =
                        Some(Instant::now() + Duration::from_millis(self.shot_config.wait_shot_ms));
                }
            },
            ShotRunnerState::WaitShot => {
                if let Some(due) = self.shot_state_due {
                    if Instant::now() >= due {
                        self.process_capture_files();
                        self.shot_state_due = None;
                        if self.shot_advance_after_capture {
                            self.shot_state = ShotRunnerState::Idle;
                            if self.shot_idx + 1 < self.shot_points.len() {
                                self.step_shot_index(1);
                            } else {
                                self.shot_running = false;
                                self.capture_status = "Shot run completed.".to_string();
                            }
                        } else {
                            self.shot_state = ShotRunnerState::WaitConfirm;
                            self.capture_status = format!(
                                "Shot {}/{} captured. Press F2 next or F3 stay.",
                                self.shot_idx + 1,
                                self.shot_points.len()
                            );
                        }
                    }
                }
            },
        }
    }

    fn trigger_reshade_screenshot(&mut self) {
        let (sent_vk_down, sent_scan_down, scan) = send_reshade_f10(false);
        self.reshade_hotkey_up_due_at =
            Some(Instant::now() + Duration::from_millis(RESHADE_HOTKEY_HOLD_MS));
        self.capture_status =
            format!("ReShade F10 down: vk={sent_vk_down} scan={sent_scan_down} sc=0x{scan:X}");
    }

    fn service_reshade_screenshot_trigger(&mut self) {
        let Some(up_due_at) = self.reshade_hotkey_up_due_at else {
            return;
        };
        if Instant::now() < up_due_at {
            return;
        }
        let (sent_vk_up, sent_scan_up, scan) = send_reshade_f10(true);
        self.capture_status =
            format!("ReShade F10 up: vk={sent_vk_up} scan={sent_scan_up} sc=0x{scan:X}");
        self.reshade_hotkey_up_due_at = None;
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
        self.update_loop_recording();
    }

    fn render(&mut self, ui: &mut imgui::Ui) {
        self.refresh_shot_config_fov_from_memory();

        if ui.is_key_pressed(Key::F9) {
            self.set_ui_visibility(!self.show_ui);
            self.show_inject_hint = false;
        }

        if ui.is_key_pressed(Key::F1) {
            if self.loop_recording {
                self.close_current_loop();
            } else {
                self.toggle_loop_recording();
            }
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

        self.service_reshade_screenshot_trigger();
        self.service_shot_runner(ui);

        let _style_tokens = [
            ui.push_style_var(StyleVar::WindowRounding(0.0)),
            ui.push_style_var(StyleVar::WindowBorderSize(0.0)),
        ];

        if self.show_ui {
            ui.window("DS3 Map Data Collector")
                .size([560.0, 430.0], Condition::FirstUseEver)
                .position([20.0, 20.0], Condition::FirstUseEver)
                .flags(WindowFlags::NO_COLLAPSE)
                .build(|| {
                if ui.small_button("Eject") {
                    self.set_ui_visibility(false);
                    BLOCK_XINPUT.store(false, Ordering::SeqCst);
                    eject();
                }
                ui.same_line();
                ui.checkbox("Shot Points Config", &mut self.show_shot_config_window);
                ui.same_line();
                ui.checkbox("Trajectory", &mut self.show_trajectory_window);

                ui.separator();
                ui.text_wrapped(format!("Capture Root: {}", self.capture_root.display()));
                ui.text("Capture Subfolder:");
                ui.input_text("##capture_subdir", &mut self.capture_subdir).build();
                ui.same_line();
                if ui.small_button("Presets") {
                    ui.open_popup("capture_subdir_presets_menu");
                }
                ui.popup("capture_subdir_presets_menu", || {
                    for item in &self.capture_subdir_presets {
                        if ui.menu_item(item) {
                            self.capture_subdir = item.clone();
                        }
                    }
                });
                if ui.button("Process Pair (F11)") {
                    self.process_capture_files();
                }
                if !self.capture_status.is_empty() {
                    ui.text_wrapped(&self.capture_status);
                }

                ui.separator();
                ui.text(format!(
                    "Shot Runner: loaded={}, index={}/{}, running={} (F2 next / F3 stay)",
                    self.shot_points.len(),
                    self.shot_idx.saturating_add(1),
                    self.shot_points.len(),
                    self.shot_running
                ));
                if ui.button("Load shot_points.json") {
                    self.load_shot_points();
                }
                ui.same_line();
                if ui.button("|<-") {
                    self.jump_to_shot_index(0);
                }
                ui.same_line();
                if ui.button("<-") {
                    self.step_shot_index(-1);
                }
                ui.same_line();
                ui.text(format!("{}/{}", self.shot_idx.saturating_add(1), self.shot_points.len()));
                ui.same_line();
                if ui.button("->") {
                    self.step_shot_index(1);
                }
                ui.same_line();
                if ui.button("->|") && !self.shot_points.is_empty() {
                    self.jump_to_shot_index(self.shot_points.len() - 1);
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
                ui.same_line();

                let mut all_no_damage = self.pointers.all_no_damage.get().unwrap_or(false);
                if ui.checkbox("All No Damage", &mut all_no_damage) {
                    self.pointers.all_no_damage.set(all_no_damage);
                }
                ui.same_line();

                let mut render_chr = self.pointers.rend_chr.get().unwrap_or(false);
                if ui.checkbox("Render Character (F6)", &mut render_chr) {
                    self.pointers.rend_chr.set(render_chr);
                }

                if ui.button("Reset Camera (F7)") {
                    self.reset_free_camera();
                }
                ui.same_line();
                if ui.button("Teleport + Del Pair (F12)") {
                    self.teleport_player_from_latest_depth_center();
                }
                ui.same_line();
                if ui.button("ReShade Shot (F10)") {
                    self.trigger_reshade_screenshot();
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
                }

                match self.camera_info.player_position() {
                    Some([px, py, pz]) => {
                        ui.text(format!("Player Position: {px:.3}, {py:.3}, {pz:.3}"));
                        match self.camera_info.camera_position() {
                            Some([cx, cy, cz]) => {
                                ui.text(format!("Camera Position: {cx:.3}, {cy:.3}, {cz:.3}"));
                                ui.text(format!("Camera-Player Height: {:.3}", cy - py));
                            },
                            None => {
                                ui.text("Camera Position: N/A");
                                ui.text("Camera-Player Height: N/A");
                            },
                        }
                    },
                    None => {
                        ui.text("Player Position: N/A");
                        match self.camera_info.camera_position() {
                            Some([cx, cy, cz]) => {
                                ui.text(format!("Camera Position: {cx:.3}, {cy:.3}, {cz:.3}"));
                            },
                            None => ui.text("Camera Position: N/A"),
                        }
                        ui.text("Camera-Player Height: N/A");
                    },
                }
            });
        }

        if self.show_ui && self.show_trajectory_window {
            ui.window("Trajectory")
                .size([420.0, 220.0], Condition::FirstUseEver)
                .position([620.0, 400.0], Condition::FirstUseEver)
                .flags(WindowFlags::NO_COLLAPSE)
                .build(|| {
                    ui.text(format!(
                        "Trajectory: {} (F1), current={}, loops={}, polylines={}",
                        if self.loop_recording { "Recording" } else { "Idle" },
                        self.current_path.len(),
                        self.closed_loops.len(),
                        self.polylines.len()
                    ));
                    if ui.button("Close Loop") {
                        self.close_current_loop();
                    }
                    ui.same_line();
                    if ui.button("Add Polyline") {
                        self.append_current_polyline();
                    }
                    if ui.button("Discard Path") {
                        self.discard_current_path();
                    }
                    ui.same_line();
                    if ui.button("Export trajectory.json") {
                        self.export_trajectory();
                    }
                    ui.same_line();
                    if ui.button("Clear Trajectory") {
                        self.clear_all_trajectories();
                    }
                });
        }

        if self.show_ui && self.show_shot_config_window {
            ui.window("Shot Points Config")
                .size([420.0, 360.0], Condition::FirstUseEver)
                .position([620.0, 20.0], Condition::FirstUseEver)
                .flags(WindowFlags::NO_COLLAPSE)
                .build(|| {
                    ui.text(format!(
                        "Auto Render Size: {} x {}",
                        self.shot_config.render_width, self.shot_config.render_height
                    ));
                    ui.text(format!("Auto FovY(rad): {:.6}", self.shot_config.fov_y_rad));
                    ui.input_float("Base Ratio px/wu", &mut self.shot_config.base_ratio_px_per_wu)
                        .build();
                    ui.input_float("Density Multiplier", &mut self.shot_config.density_multiplier)
                        .build();
                    ui.input_float("Overlap Ratio", &mut self.shot_config.overlap_ratio).build();
                    ui.input_float("Polyline Buffer", &mut self.shot_config.polyline_buffer_world)
                        .build();
                    ui.input_scalar("Y Neighbor K", &mut self.shot_config.y_neighbor_k).build();
                    ui.input_float("Y Lift", &mut self.shot_config.y_lift).build();
                    ui.input_scalar("Wait Load ms", &mut self.shot_config.wait_load_ms).build();
                    ui.input_scalar("Wait Shot ms", &mut self.shot_config.wait_shot_ms).build();

                    if ui.button("Save Config") {
                        self.save_shot_config();
                    }
                    ui.same_line();
                    if ui.button("Load Config") {
                        self.load_shot_config();
                    }
                });
        }

        BLOCK_XINPUT
            .store(ui.io().want_capture_mouse || ui.io().want_capture_keyboard, Ordering::SeqCst);
    }
}

fn send_reshade_f10(key_up: bool) -> (u32, u32, u16) {
    let vk = VIRTUAL_KEY(VK_F10.0);
    let scan = unsafe { MapVirtualKeyW(VK_F10.0 as u32, MAPVK_VK_TO_VSC) } as u16;
    let vk_flags = if key_up { KEYEVENTF_KEYUP } else { Default::default() };
    let scan_flags = if key_up { KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP } else { KEYEVENTF_SCANCODE };

    let vk_input = [INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: vk_flags, time: 0, dwExtraInfo: 0 },
        },
    }];
    let scan_input = [INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan,
                dwFlags: scan_flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }];
    let cb_size = std::mem::size_of::<INPUT>() as i32;
    let sent_vk = unsafe { SendInput(&vk_input, cb_size) };
    let sent_scan = unsafe { SendInput(&scan_input, cb_size) };
    (sent_vk, sent_scan, scan)
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

fn parse_subdir_presets(raw: &str) -> Vec<String> {
    let mut items: Vec<String> = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(ToOwned::to_owned)
        .collect();
    items.sort();
    items.dedup();
    if !items.iter().any(|x| x == "default") {
        items.insert(0, "default".to_string());
    }
    items
}

fn load_trajectory_points(path: &std::path::Path) -> Vec<[f32; 3]> {
    if !path.is_file() {
        return Vec::new();
    }
    let bytes = match fs::read(path) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let parsed: TrajectoryFile = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut pts = Vec::new();
    let src_space = parse_coord_space(&parsed.coord_space);
    for lp in parsed.loops {
        pts.extend(lp);
    }
    for ln in parsed.polylines {
        pts.extend(ln);
    }
    for p in &mut pts {
        p[2] = convert_z(p[2], src_space, CoordSpace::Game);
    }
    pts
}

fn nearest_point(target: [f32; 3], candidates: &[[f32; 3]]) -> Option<[f32; 3]> {
    let mut best: Option<([f32; 3], f32)> = None;
    for &p in candidates {
        let dx = p[0] - target[0];
        let dy = p[1] - target[1];
        let dz = p[2] - target[2];
        let d2 = dx * dx + dy * dy + dz * dz;
        match best {
            Some((_, bd2)) if bd2 <= d2 => {},
            _ => best = Some((p, d2)),
        }
    }
    best.map(|v| v.0)
}

fn dedup_paths(paths: &mut Vec<Vec<[f32; 3]>>) {
    let mut out: Vec<Vec<[f32; 3]>> = Vec::new();
    for p in paths.drain(..) {
        if p.is_empty() {
            continue;
        }
        let first = p[0];
        let dup = out.iter().any(|e| {
            if e.len() != p.len() {
                return false;
            }
            let ef = e[0];
            let dx = first[0] - ef[0];
            let dy = first[1] - ef[1];
            let dz = first[2] - ef[2];
            (dx * dx + dy * dy + dz * dz).sqrt() <= 0.05
        });
        if !dup {
            out.push(p);
        }
    }
    *paths = out;
}
