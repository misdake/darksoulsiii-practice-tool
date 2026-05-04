use libds3::memedit::PointerChain;
use libds3::pointers::{CameraRenderState, PointerChains};

pub struct CameraInfo {
    player_position: PointerChain<[f32; 3]>,
    camera_position: PointerChain<[f32; 3]>,
    free_camera_state: PointerChain<u32>,
    camera_render_state: PointerChain<CameraRenderState>,
    free_camera_enabled: Option<bool>,
    camera_render_state_value: Option<CameraRenderState>,
}

impl CameraInfo {
    pub fn new(pointers: &PointerChains) -> Self {
        CameraInfo {
            player_position: pointers.position.1.clone(),
            camera_position: pointers.camera.position_global.clone(),
            free_camera_state: pointers.camera.free_camera_state.clone(),
            camera_render_state: pointers.camera.render_state.clone(),
            free_camera_enabled: None,
            camera_render_state_value: None,
        }
    }

    pub fn player_position(&self) -> Option<[f32; 3]> {
        self.player_position.read()
    }

    pub fn camera_position(&self) -> Option<[f32; 3]> {
        self.camera_position.read()
    }

    pub fn free_camera_enabled(&self) -> Option<bool> {
        self.free_camera_enabled
    }

    pub fn set_free_camera_enabled(&self, enabled: bool) {
        self.free_camera_state.write(if enabled { 1_u32 } else { 0_u32 });
    }

    pub fn set_camera_position(&self, position: [f32; 3]) {
        self.camera_position.write(position);

        if let Some(mut state) = self.camera_render_state.read() {
            state.position = position;
            self.camera_render_state.write(state);
        }
    }

    pub fn set_camera_position_from_player_offset(&self, offset: [f32; 3]) {
        if let Some([px, py, pz]) = self.player_position.read() {
            let target = [px + offset[0], py + offset[1], pz + offset[2]];
            self.set_camera_position(target);
        }
    }

    pub fn teleport_player_to_camera(&self, y_offset: f32) {
        if let Some([cx, cy, cz]) = self.camera_position.read() {
            self.player_position.write([cx, cy + y_offset, cz]);
        }
    }

    pub fn camera_render_state(&self) -> Option<CameraRenderState> {
        self.camera_render_state_value
    }

    pub fn set_fovy_rad(&self, fovy_rad: f32) {
        if let Some(mut state) = self.camera_render_state.read() {
            state.fov = fovy_rad;
            self.camera_render_state.write(state);
        }
    }

    pub fn set_near_far(&self, near: f32, far: f32) -> bool {
        if !(0.001 < near && near < far && far < 100000.0) {
            return false;
        }

        if let Some(mut state) = self.camera_render_state.read() {
            state.near = near;
            state.far = far;
            self.camera_render_state.write(state);
            return true;
        }

        false
    }

    pub fn set_quat(&self, wxyz: [f32; 4]) {
        if let Some(mut state) = self.camera_render_state.read() {
            // This orientation points the camera forward to Y- and up to Z-.
            state.quat_w = wxyz[0];
            state.quat_xyz = [wxyz[1], wxyz[2], wxyz[3]];
            self.camera_render_state.write(state);
        }
    }

    pub fn ui_pointers_available(&self) -> bool {
        self.free_camera_enabled.is_some() && self.camera_render_state_value.is_some()
    }

    pub fn update(&mut self) {
        self.free_camera_enabled = self.free_camera_state.read().map(|v| v == 1);
        self.camera_render_state_value = self.camera_render_state.read();
    }
}
