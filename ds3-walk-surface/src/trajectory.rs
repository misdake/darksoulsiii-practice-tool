use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Deserialize)]
struct TrajectoryFile {
    #[serde(default)]
    coord_space: String,
    #[serde(default)]
    loops: Vec<Vec<[f32; 3]>>,
    #[serde(default)]
    polylines: Vec<Vec<[f32; 3]>>,
}

#[derive(Clone, Copy, Debug)]
pub enum CoordSpace {
    Game,
    Internal,
}

impl CoordSpace {
    pub fn from_str(s: &str) -> Self {
        match s {
            "internal" | "processor" => Self::Internal,
            _ => Self::Game,
        }
    }
}

pub fn to_internal(p: [f32; 3], from: CoordSpace) -> [f32; 3] {
    match from {
        CoordSpace::Internal => p,
        CoordSpace::Game => p,
    }
}

pub fn load_trajectory_points_internal(path: &Path) -> Result<Vec<[f32; 3]>> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let file: TrajectoryFile =
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    let src = CoordSpace::from_str(&file.coord_space);
    let mut out = Vec::new();
    for lp in file.loops {
        for p in lp {
            out.push(to_internal(p, src));
        }
    }
    for line in file.polylines {
        for p in line {
            out.push(to_internal(p, src));
        }
    }
    Ok(out)
}
