use std::path::PathBuf;

use hudhook::tracing::error;
use serde::{Deserialize, Serialize};

use crate::map::{MapMode, SIZE_SCALE_MAX, SIZE_SCALE_MIN};
use crate::util;

const CONFIG_FILE_NAME: &str = "ds3_map_viewer.toml";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppConfig {
    pub map: MapConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MapConfig {
    pub map_size_scale: f32,
    pub map_indicator_scale: f32,
    pub map_level: i32,
    pub map_mode: String,
    pub map_tiles_root: String,
    pub map_z_flip: bool,

    #[allow(dead_code)]
    #[serde(skip_serializing, default)]
    pub map_zoom_scale: Option<f32>,
}

impl Default for MapConfig {
    fn default() -> Self {
        MapConfig {
            map_size_scale: 1.0,
            map_indicator_scale: 1.0,
            map_level: -1,
            map_mode: "square_rotate_with_player".to_string(),
            map_tiles_root: "map-work/tiles".to_string(),
            map_z_flip: true,
            map_zoom_scale: None,
        }
    }
}

impl MapConfig {
    fn sanitize(&mut self) {
        self.map_size_scale = self.map_size_scale.clamp(SIZE_SCALE_MIN, SIZE_SCALE_MAX);
        self.map_indicator_scale =
            self.map_indicator_scale.clamp(crate::map::INDICATOR_SCALE_MIN, crate::map::INDICATOR_SCALE_MAX);

        if self.map_tiles_root.trim().is_empty() {
            self.map_tiles_root = "map-work/tiles".to_string();
        }
    }

    pub fn mode(&self) -> MapMode {
        match self.map_mode.as_str() {
            "circle_north_up" => MapMode::SquareNorthUp,
            "square_north_up" => MapMode::SquareNorthUp,
            _ => MapMode::SquareRotateWithPlayer,
        }
    }

    pub fn set_mode(&mut self, mode: MapMode) {
        self.map_mode = mode.as_str().to_string();
    }
}

pub struct ConfigStore {
    path: Option<PathBuf>,
    config: AppConfig,
}

impl ConfigStore {
    pub fn load() -> Self {
        let path = util::get_dll_path().map(|mut path| {
            path.pop();
            path.push(CONFIG_FILE_NAME);
            path
        });

        let mut config = AppConfig::default();

        if let Some(path) = path.as_ref() {
            util::append_log_line(&format!("config path: {}", path.display()));
            if path.exists() {
                match std::fs::read_to_string(path) {
                    Ok(content) => match toml::from_str::<AppConfig>(&content) {
                        Ok(mut loaded) => {
                            loaded.map.sanitize();
                            config = loaded;
                            util::append_log_line("config loaded");
                        },
                        Err(e) => {
                            error!("Couldn't parse {}: {}", CONFIG_FILE_NAME, e);
                            util::append_log_line(&format!("config parse error: {}", e));
                        },
                    },
                    Err(e) => {
                        error!("Couldn't read {}: {}", CONFIG_FILE_NAME, e);
                        util::append_log_line(&format!("config read error: {}", e));
                    },
                }
            } else {
                util::append_log_line("config missing, using defaults");
            }
        }

        ConfigStore { path, config }
    }

    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    pub fn set_map(&mut self, mut map: MapConfig) {
        map.sanitize();
        self.config.map = map;
    }

    pub fn save(&self) {
        let Some(path) = self.path.as_ref() else {
            return;
        };

        match toml::to_string_pretty(&self.config) {
            Ok(content) => {
                if let Err(e) = std::fs::write(path, content) {
                    error!("Couldn't write {}: {}", CONFIG_FILE_NAME, e);
                }
            },
            Err(e) => error!("Couldn't serialize {}: {}", CONFIG_FILE_NAME, e),
        }
    }
}
