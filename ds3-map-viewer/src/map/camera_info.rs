use libds3::memedit::PointerChain;
use libds3::pointers::PointerChains;

pub struct CameraInfo {
    position: PointerChain<[f32; 3]>,
    camera_angle_follow: PointerChain<[f32; 2]>,
    camera_position_follow: PointerChain<[f32; 3]>,
    camera_position_global: PointerChain<[f32; 3]>,
    player_position: Option<[f32; 3]>,
    camera_follow_saved: [f32; 3],
    camera_global_saved: [f32; 3],
    in_game_saved: [bool; 5],
    in_game_saved_len: usize,
    in_game_saved_next: usize,
}

impl CameraInfo {
    pub fn new(pointers: &PointerChains) -> Self {
        CameraInfo {
            position: pointers.position.1.clone(),
            camera_angle_follow: pointers.camera.angle_follow.clone(),
            camera_position_follow: pointers.camera.position_follow.clone(),
            camera_position_global: pointers.camera.position_global.clone(),
            player_position: None,
            camera_follow_saved: [0., 0., 0.],
            camera_global_saved: [0., 0., 0.],
            in_game_saved: [false; 5],
            in_game_saved_len: 0,
            in_game_saved_next: 0,
        }
    }

    pub fn player_position(&self) -> Option<[f32; 3]> {
        self.player_position
    }

    /// returns (visible, dir)
    pub fn update(&mut self) -> (bool, f32) {
        if let (
            Some(player_position),
            Some(camera_follow),
            Some(camera_global),
            Some([_rot_x, rot_y]),
        ) = (
            self.position.read(),
            self.camera_position_follow.read(),
            self.camera_position_global.read(),
            self.camera_angle_follow.read(),
        ) {
            self.player_position = Some(player_position);

            let rot_y = if rot_y < 0. { rot_y + std::f32::consts::TAU } else { rot_y };

            fn almost_same(a: [f32; 3], b: [f32; 3]) -> bool {
                const E: f32 = 0.0001;
                (a[0] - b[0]).abs() < E && (a[1] - b[1]).abs() < E && (a[2] - b[2]).abs() < E
            }

            // try to resolve camera position delay.
            let same0 = almost_same(camera_global, camera_follow);
            let same1 = almost_same(camera_global, self.camera_follow_saved);
            let same2 = almost_same(camera_follow, self.camera_global_saved);
            let in_game = same0 || same1 || same2;
            self.camera_follow_saved = camera_follow;
            self.camera_global_saved = camera_global;

            self.in_game_saved[self.in_game_saved_next] = in_game;
            self.in_game_saved_next = (self.in_game_saved_next + 1) % self.in_game_saved.len();
            self.in_game_saved_len = (self.in_game_saved_len + 1).min(self.in_game_saved.len());

            let visible = self.in_game_saved.iter().take(self.in_game_saved_len).any(|i| *i);

            (visible, rot_y)
        } else {
            // bad memory => hide compass
            self.player_position = None;
            self.camera_follow_saved = [0., 0., 0.];
            self.camera_global_saved = [0., 0., 0.];
            self.in_game_saved = [false; 5];
            self.in_game_saved_len = 0;
            self.in_game_saved_next = 0;

            (false, 0.)
        }
    }
}
