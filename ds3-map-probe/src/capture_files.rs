use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use libds3::pointers::CameraRenderState;

pub struct CaptureContext {
    pub player_position: Option<[f32; 3]>,
    pub camera_position: Option<[f32; 3]>,
    pub camera_render_state: Option<CameraRenderState>,
}

struct CaptureGroup {
    rgb: Option<PathBuf>,
    depth: Option<PathBuf>,
    newest_unix_secs: i64,
}

pub fn process_latest_capture(
    game_dir: &Path,
    output_dir: &Path,
    ctx: &CaptureContext,
) -> Result<String, String> {
    let groups = discover_capture_groups(game_dir)?;
    let (prefix, group) = groups
        .into_iter()
        .filter(|(_, g)| g.rgb.is_some() && g.depth.is_some())
        .max_by_key(|(_, g)| g.newest_unix_secs)
        .ok_or_else(|| "No rgb/depth capture pair found in game directory.".to_string())?;

    fs::create_dir_all(output_dir).map_err(|e| format!("Create output dir failed: {e}"))?;

    let rgb_src = group.rgb.expect("filtered above");
    let depth_src = group.depth.expect("filtered above");
    let rgb_name = rgb_src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid rgb filename.".to_string())?
        .to_string();
    let depth_name = depth_src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid depth filename.".to_string())?
        .to_string();

    let rgb_dst = output_dir.join(&rgb_name);
    let depth_dst = output_dir.join(&depth_name);

    move_file(&rgb_src, &rgb_dst)?;
    move_file(&depth_src, &depth_dst)?;

    let meta_name = format!("{prefix}.toml");
    let meta_path = output_dir.join(meta_name);
    let toml_text = build_metadata_toml(&rgb_name, &depth_name, ctx)?;
    fs::write(&meta_path, toml_text).map_err(|e| format!("Write metadata failed: {e}"))?;

    Ok(format!("Moved rgb/depth and wrote metadata: {}", meta_path.display()))
}

fn discover_capture_groups(game_dir: &Path) -> Result<HashMap<String, CaptureGroup>, String> {
    let entries = fs::read_dir(game_dir).map_err(|e| format!("Read game dir failed: {e}"))?;
    let mut groups: HashMap<String, CaptureGroup> = HashMap::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Read dir entry failed: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };

        let (prefix, is_rgb, is_depth) = if let Some(prefix) = name.strip_suffix(" BackBuffer.bmp")
        {
            (prefix.to_string(), true, false)
        } else if let Some(prefix) = name.strip_suffix(" DepthBuffer.exr") {
            (prefix.to_string(), false, true)
        } else {
            continue;
        };

        let modified =
            fs::metadata(&path).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        let unix_secs =
            modified.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);

        let group = groups.entry(prefix).or_insert(CaptureGroup {
            rgb: None,
            depth: None,
            newest_unix_secs: unix_secs,
        });
        group.newest_unix_secs = group.newest_unix_secs.max(unix_secs);

        if is_rgb {
            group.rgb = Some(path);
        } else if is_depth {
            group.depth = Some(path);
        }
    }

    Ok(groups)
}

fn move_file(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::rename(src, dst) {
        Ok(_) => Ok(()),
        Err(_) => {
            fs::copy(src, dst).map_err(|e| format!("Copy failed ({}): {e}", src.display()))?;
            fs::remove_file(src)
                .map_err(|e| format!("Remove source failed ({}): {e}", src.display()))
                .map(|_| ())
        },
    }
}

fn build_metadata_toml(
    rgb_file: &str,
    depth_file: &str,
    ctx: &CaptureContext,
) -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Clock error: {e}"))?
        .as_secs_f64();

    let mut out = String::new();
    out.push_str(&format!("timestamp_unix = {now}\n"));
    out.push_str(&format!("rgb_file = \"{}\"\n", escape_toml_string(rgb_file)));
    out.push_str(&format!("depth_file = \"{}\"\n", escape_toml_string(depth_file)));

    if let Some([x, y, z]) = ctx.player_position {
        out.push_str(&format!("player_position = [{x}, {y}, {z}]\n"));
    }
    if let Some([x, y, z]) = ctx.camera_position {
        out.push_str(&format!("camera_position = [{x}, {y}, {z}]\n"));
    }
    if let Some(state) = ctx.camera_render_state {
        let [ux, uy, uz] = state.camera_up;
        let [dx, dy, dz] = state.camera_dir;
        out.push_str(&format!("camera_up = [{ux}, {uy}, {uz}]\n"));
        out.push_str(&format!("camera_dir = [{dx}, {dy}, {dz}]\n"));
        out.push_str(&format!("camera_fov = {}\n", state.fov));
        out.push_str(&format!("camera_near = {}\n", state.near));
        out.push_str(&format!("camera_far = {}\n", state.far));
    }

    Ok(out)
}

fn escape_toml_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}
