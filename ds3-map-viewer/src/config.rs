use std::path::PathBuf;

use hudhook::tracing::error;
use serde::{Deserialize, Serialize};

use crate::map::{
    DIRECTION_OFFSET_MAX, DIRECTION_OFFSET_MIN, SIZE_SCALE_MAX, SIZE_SCALE_MIN,
};
use crate::util;

const CONFIG_FILE_NAME: &str = "ds3_map_viewer.toml";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub map: MapConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig { map: MapConfig::default() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MapConfig {
    pub compass_direction_offset_degrees: f32,
    pub compass_size_scale: f32,
}

impl Default for MapConfig {
    fn default() -> Self {
        MapConfig { compass_direction_offset_degrees: 0.0, compass_size_scale: 1.0 }
    }
}

impl MapConfig {
    fn sanitize(&mut self) {
        self.compass_direction_offset_degrees =
            self.compass_direction_offset_degrees.clamp(DIRECTION_OFFSET_MIN, DIRECTION_OFFSET_MAX);
        self.compass_size_scale = self.compass_size_scale.clamp(SIZE_SCALE_MIN, SIZE_SCALE_MAX);
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
            if path.exists() {
                match std::fs::read_to_string(path) {
                    Ok(content) => match toml::from_str::<AppConfig>(&content) {
                        Ok(mut loaded) => {
                            loaded.map.sanitize();
                            config = loaded;
                        },
                        Err(e) => error!("Couldn't parse {}: {}", CONFIG_FILE_NAME, e),
                    },
                    Err(e) => error!("Couldn't read {}: {}", CONFIG_FILE_NAME, e),
                }
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
