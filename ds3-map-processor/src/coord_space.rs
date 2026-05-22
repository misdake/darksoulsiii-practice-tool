#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordSpace {
    Game,
    Processor,
}

impl CoordSpace {
    pub fn from_str(s: &str) -> Self {
        match s {
            "processor" => Self::Processor,
            _ => Self::Game,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Game => "game",
            Self::Processor => "processor",
        }
    }
}

pub fn parse_coord_space(raw: &str) -> CoordSpace {
    CoordSpace::from_str(raw)
}

pub fn z_sign(from: CoordSpace, to: CoordSpace) -> f32 {
    if from == to {
        1.0
    } else {
        -1.0
    }
}

pub fn convert_z(z: f32, from: CoordSpace, to: CoordSpace) -> f32 {
    z * z_sign(from, to)
}
