use libds3::memedit::PointerChain;
use libds3::pointers::PointerChains;

pub struct CameraInfo {
    position: PointerChain<[f32; 3]>,
    camera_angle_follow: PointerChain<[f32; 2]>,
    camera_position_follow: PointerChain<[f32; 3]>,
    camera_position_global: PointerChain<[f32; 3]>,
    player_position: Option<[f32; 3]>,
    camera_position_global_value: Option<[f32; 3]>,
    camera_position_follow_value: Option<[f32; 3]>,
    camera_angle_follow_value: Option<[f32; 2]>,
    in_game_saved: [bool; 5],
    in_game_saved_len: usize,
    in_game_saved_next: usize,
}

impl CameraInfo {
    pub fn new(pointers: &PointerChains) -> Self {
        CameraInfo {
            position: pointers.position.1.clone(),
            camera_angle_follow: pointers.camera_angle_follow.clone(),
            camera_position_follow: pointers.camera_position_follow.clone(),
            camera_position_global: pointers.camera_position_global.clone(),
            player_position: None,
            camera_position_global_value: None,
            camera_position_follow_value: None,
            camera_angle_follow_value: None,
            in_game_saved: [false; 5],
            in_game_saved_len: 0,
            in_game_saved_next: 0,
        }
    }

    pub fn player_position(&self) -> Option<[f32; 3]> {
        self.player_position
    }

    pub fn camera_position_global(&self) -> Option<[f32; 3]> {
        self.camera_position_global_value
    }

    pub fn camera_position_follow(&self) -> Option<[f32; 3]> {
        self.camera_position_follow_value
    }

    pub fn camera_angle_follow(&self) -> Option<[f32; 2]> {
        self.camera_angle_follow_value
    }

    pub fn in_game_estimated(&self) -> bool {
        self.in_game_saved.iter().take(self.in_game_saved_len).any(|i| *i)
    }

    pub fn update(&mut self) {
        let player_position = self.position.read();
        let camera_follow = self.camera_position_follow.read();
        let camera_global = self.camera_position_global.read();
        let camera_angle = self.camera_angle_follow.read();

        self.player_position = player_position;
        self.camera_position_follow_value = camera_follow;
        self.camera_position_global_value = camera_global;
        self.camera_angle_follow_value = camera_angle;

        let in_game = player_position.is_some()
            && camera_follow.is_some()
            && camera_global.is_some()
            && camera_angle.is_some();

        self.in_game_saved[self.in_game_saved_next] = in_game;
        self.in_game_saved_next = (self.in_game_saved_next + 1) % self.in_game_saved.len();
        self.in_game_saved_len = (self.in_game_saved_len + 1).min(self.in_game_saved.len());
    }
}
