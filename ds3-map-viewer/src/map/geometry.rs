#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipMode {
    CircleNorthUp,
    SquareRotateWithPlayer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Hidden,
    Partial,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisibleMarker {
    pub screen_anchor: [f32; 2],
    pub screen_rect: [f32; 4],
}

#[derive(Debug, Clone, Copy)]
pub struct MapViewParams {
    pub center_world_xz: [f32; 2],
    pub center_screen_px: [f32; 2],
    pub world_units_per_px: f32,
    pub half_extent_px: f32,
    pub rotation_rad: f32,
    pub clip_mode: ClipMode,
}

impl MapViewParams {
    pub fn world_to_screen(&self, world_xz: [f32; 2]) -> [f32; 2] {
        let dx = world_xz[0] - self.center_world_xz[0];
        let dz = world_xz[1] - self.center_world_xz[1];
        let (sin, cos) = self.rotation_rad.sin_cos();
        let rx = cos * dx - sin * dz;
        let rz = sin * dx + cos * dz;

        [
            self.center_screen_px[0] + rx / self.world_units_per_px,
            self.center_screen_px[1] + rz / self.world_units_per_px,
        ]
    }

    pub fn tile_visibility(&self, tile_world_aabb: [f32; 4]) -> Visibility {
        let corners = [
            [tile_world_aabb[0], tile_world_aabb[2]],
            [tile_world_aabb[1], tile_world_aabb[2]],
            [tile_world_aabb[1], tile_world_aabb[3]],
            [tile_world_aabb[0], tile_world_aabb[3]],
        ];
        let screen = corners.map(|p| self.world_to_screen(p));

        let inside_count = screen.iter().filter(|p| self.screen_inside(**p)).count();
        if inside_count == 4 {
            return Visibility::Full;
        }
        if inside_count > 0 {
            return Visibility::Partial;
        }

        let [min_x, max_x, min_y, max_y] = screen_bounds(&screen);
        let rect = [
            self.center_screen_px[0] - self.half_extent_px,
            self.center_screen_px[0] + self.half_extent_px,
            self.center_screen_px[1] - self.half_extent_px,
            self.center_screen_px[1] + self.half_extent_px,
        ];

        let separated = max_x < rect[0] || min_x > rect[1] || max_y < rect[2] || min_y > rect[3];
        if separated {
            return Visibility::Hidden;
        }

        if matches!(self.clip_mode, ClipMode::CircleNorthUp) {
            let closest_x = self.center_screen_px[0].clamp(min_x, max_x);
            let closest_y = self.center_screen_px[1].clamp(min_y, max_y);
            let dx = closest_x - self.center_screen_px[0];
            let dy = closest_y - self.center_screen_px[1];
            if (dx * dx + dy * dy) > self.half_extent_px * self.half_extent_px {
                return Visibility::Hidden;
            }
        }

        Visibility::Partial
    }

    pub fn marker_visibility(
        &self,
        world_xz: [f32; 2],
        billboard_size_px: [f32; 2],
        pivot: [f32; 2],
    ) -> Option<VisibleMarker> {
        let anchor = self.world_to_screen(world_xz);
        if !self.screen_inside(anchor) {
            return None;
        }

        let left = anchor[0] - billboard_size_px[0] * pivot[0];
        let top = anchor[1] - billboard_size_px[1] * pivot[1];
        Some(VisibleMarker {
            screen_anchor: anchor,
            screen_rect: [left, top, left + billboard_size_px[0], top + billboard_size_px[1]],
        })
    }

    pub fn screen_inside(&self, p: [f32; 2]) -> bool {
        let dx = p[0] - self.center_screen_px[0];
        let dy = p[1] - self.center_screen_px[1];
        match self.clip_mode {
            ClipMode::SquareRotateWithPlayer => {
                dx.abs() <= self.half_extent_px && dy.abs() <= self.half_extent_px
            },
            ClipMode::CircleNorthUp => {
                (dx * dx + dy * dy) <= self.half_extent_px * self.half_extent_px
            },
        }
    }
}

fn screen_bounds(points: &[[f32; 2]; 4]) -> [f32; 4] {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for p in points {
        min_x = min_x.min(p[0]);
        max_x = max_x.max(p[0]);
        min_y = min_y.min(p[1]);
        max_y = max_y.max(p[1]);
    }
    [min_x, max_x, min_y, max_y]
}

#[cfg(test)]
mod tests {
    use super::{ClipMode, MapViewParams, Visibility};

    #[test]
    fn square_visibility_inside() {
        let view = MapViewParams {
            center_world_xz: [0.0, 0.0],
            center_screen_px: [100.0, 100.0],
            world_units_per_px: 1.0,
            half_extent_px: 50.0,
            rotation_rad: 0.0,
            clip_mode: ClipMode::SquareRotateWithPlayer,
        };
        assert_eq!(view.tile_visibility([-10.0, 10.0, -10.0, 10.0]), Visibility::Full);
    }

    #[test]
    fn circle_marker_visibility() {
        let view = MapViewParams {
            center_world_xz: [0.0, 0.0],
            center_screen_px: [0.0, 0.0],
            world_units_per_px: 1.0,
            half_extent_px: 20.0,
            rotation_rad: 0.0,
            clip_mode: ClipMode::CircleNorthUp,
        };
        assert!(view.marker_visibility([10.0, 0.0], [8.0, 8.0], [0.5, 0.5]).is_some());
        assert!(view.marker_visibility([30.0, 0.0], [8.0, 8.0], [0.5, 0.5]).is_none());
    }
}
