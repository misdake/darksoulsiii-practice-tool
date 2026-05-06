use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use kiss3d::camera::OrbitCamera3d;
use kiss3d::egui::{self, Align2, Color32};
use kiss3d::event::{Action, Key, WindowEvent};
use kiss3d::glamx::Vec3;
use kiss3d::prelude::{Color, SceneNode3d, Window, WHITE};
use ply_rs::parser::Parser;
use ply_rs::ply::{Property, PropertyAccess};
use rfd::FileDialog;

#[derive(Clone)]
struct PointCloud {
    source: PathBuf,
    points: Vec<Vec3>,
    colors: Vec<Color>,
    visible: bool,
}

#[derive(Clone, Copy, Default)]
struct VertexLite {
    x: f32,
    y: f32,
    z: f32,
    r: u8,
    g: u8,
    b: u8,
    has_color: bool,
}

impl PropertyAccess for VertexLite {
    fn new() -> Self {
        Self::default()
    }

    fn set_property(&mut self, property_name: String, property: Property) {
        match property_name.as_str() {
            "x" => self.x = property_to_f32(&property).unwrap_or(self.x),
            "y" => self.y = property_to_f32(&property).unwrap_or(self.y),
            "z" => self.z = property_to_f32(&property).unwrap_or(self.z),
            "red" | "r" => {
                if let Some(v) = property_to_u8(&property) {
                    self.r = v;
                    self.has_color = true;
                }
            },
            "green" | "g" => {
                if let Some(v) = property_to_u8(&property) {
                    self.g = v;
                    self.has_color = true;
                }
            },
            "blue" | "b" => {
                if let Some(v) = property_to_u8(&property) {
                    self.b = v;
                    self.has_color = true;
                }
            },
            _ => {},
        }
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("Error: {e:#}");
    }
}

fn run() -> Result<()> {
    let mut window = kiss3d::pollster::block_on(Window::new("DS3 PLY Preview (kiss3d)"));
    window.set_background_color(Color::new(0.08, 0.08, 0.08, 1.0));
    let mut perspective = OrbitCamera3d::new_with_frustum(
        45_f32.to_radians(),
        0.01,
        1_000_000.0,
        Vec3::new(0.0, 0.0, 10.0),
        Vec3::ZERO,
    );
    // Invert mouse-wheel zoom direction to match expected UX.
    perspective.set_dist_step(1.0 / 1.01);
    perspective.set_fov(45_f32.to_radians());
    let mut scene = SceneNode3d::empty();

    let mut clouds: Vec<PointCloud> = Vec::new();
    let mut point_size = 1.0_f32;
    let mut fps = 0.0_f32;
    let mut fps_frames = 0_u32;
    let mut fps_last = Instant::now();

    while kiss3d::pollster::block_on(window.render_3d(&mut scene, &mut perspective)) {
        fps_frames += 1;
        let now = Instant::now();
        let dt = now.duration_since(fps_last).as_secs_f32();
        if dt >= 0.25 {
            fps = fps_frames as f32 / dt;
            fps_frames = 0;
            fps_last = now;
        }

        for event in window.events().iter() {
            if let WindowEvent::Key(key, Action::Release, _) = event.value {
                match key {
                    Key::LBracket => point_size = (point_size - 0.25).max(1.0),
                    Key::RBracket => point_size = (point_size + 0.25).min(10.0),
                    _ => {},
                }
            }
        }

        let ui_capturing_keyboard = window.is_egui_capturing_keyboard();
        if !ui_capturing_keyboard {
            apply_keyboard_camera_controls(&window, &mut perspective);
        }
        for cloud in &clouds {
            if !cloud.visible {
                continue;
            }
            for (idx, point) in cloud.points.iter().enumerate() {
                let color = cloud.colors.get(idx).copied().unwrap_or(WHITE);
                window.draw_point(*point, color, point_size);
            }
        }

        let mut ui_request_open = false;
        let mut ui_request_clear = false;
        let mut ui_request_fit = false;
        window.draw_ui(|ctx| {
            egui::Window::new("PLY Viewer")
                .anchor(Align2::LEFT_TOP, [10.0, 10.0])
                .resizable(true)
                .default_width(360.0)
                .show(ctx, |ui| {
                    ui.style_mut().interaction.selectable_labels = false;
                    ui.horizontal(|ui| {
                        if ui.button("Open PLY...").clicked() {
                            ui_request_open = true;
                        }
                        if ui.button("Clear").clicked() {
                            ui_request_clear = true;
                        }
                        if ui.button("Fit").clicked() {
                            ui_request_fit = true;
                        }
                    });
                    ui.separator();
                    ui.add(egui::Slider::new(&mut point_size, 1.0..=10.0).text("Point Size"));
                    ui.separator();
                    ui.separator();
                    ui.label("Loaded clouds:");
                    let mut visible_clouds = 0usize;
                    let mut visible_points = 0usize;
                    egui::ScrollArea::vertical().max_height(180.0).show(ui, |ui| {
                        for cloud in clouds.iter_mut().take(128) {
                            if cloud.visible {
                                visible_clouds += 1;
                                visible_points += cloud.points.len();
                            }
                            let label = format!(
                                "{} ({} pts)",
                                short_cloud_name(&cloud.source),
                                cloud.points.len()
                            );
                            ui.checkbox(&mut cloud.visible, label);
                        }
                        if clouds.is_empty() {
                            ui.colored_label(Color32::DARK_GRAY, "(none)");
                        }
                    });
                    ui.separator();
                    ui.label(format!("FPS: {:.1}", fps));
                    ui.label(format!("Visible Clouds: {}", visible_clouds));
                    ui.label(format!("Visible Points: {}", visible_points));
                    ui.separator();
                    ui.colored_label(
                        Color32::LIGHT_BLUE,
                        "Hotkeys: [ ] point size, WASDQE move, Z/C zoom",
                    );
                });
        });

        if ui_request_open {
            let (ok, _) = import_ply_files(&mut clouds);
            if ok > 0 {
                let _ = center_all_points(&clouds, &mut perspective);
            }
        }
        if ui_request_clear {
            clouds.clear();
        }
        if ui_request_fit {
            let _ = center_all_points(&clouds, &mut perspective);
        }
    }

    Ok(())
}

fn import_ply_files(clouds: &mut Vec<PointCloud>) -> (usize, usize) {
    let mut ok = 0usize;
    let mut failed = 0usize;
    if let Some(paths) = FileDialog::new().add_filter("PLY", &["ply"]).pick_files() {
        for p in paths {
            match load_ply_points(&p) {
                Ok(c) => {
                    clouds.push(c);
                    ok += 1;
                },
                Err(_) => failed += 1,
            }
        }
    }
    (ok, failed)
}

fn apply_keyboard_camera_controls(window: &Window, perspective: &mut OrbitCamera3d) {
    let speed = 0.15_f32;
    let zoom_factor = 1.02_f32;
    let mut t = perspective.at();
    if window.get_key(Key::W) == Action::Press {
        t.z -= speed;
    }
    if window.get_key(Key::S) == Action::Press {
        t.z += speed;
    }
    if window.get_key(Key::A) == Action::Press {
        t.x -= speed;
    }
    if window.get_key(Key::D) == Action::Press {
        t.x += speed;
    }
    if window.get_key(Key::Q) == Action::Press {
        t.y += speed;
    }
    if window.get_key(Key::E) == Action::Press {
        t.y -= speed;
    }
    perspective.set_at(t);

    let mut d = perspective.dist();
    if window.get_key(Key::Z) == Action::Press {
        d *= zoom_factor;
    }
    if window.get_key(Key::C) == Action::Press {
        d /= zoom_factor;
    }
    perspective.set_dist(d.max(0.001));
}

fn center_all_points(clouds: &[PointCloud], perspective: &mut OrbitCamera3d) -> bool {
    let mut has_any = false;
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);

    for cloud in clouds {
        for p in &cloud.points {
            has_any = true;
            min = min.min(*p);
            max = max.max(*p);
        }
    }

    if !has_any {
        return false;
    }

    let center = (min + max) * 0.5;
    let ext = (max - min) * 0.5;
    let radius = ext.length().max(1.0);

    perspective.set_at(center);
    perspective.set_dist((radius * 2.5).max(2.0));

    true
}

fn load_ply_points(path: &Path) -> Result<PointCloud> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut reader = BufReader::new(file);
    let parser = Parser::<VertexLite>::new();
    let header = parser
        .read_header(&mut reader)
        .with_context(|| format!("read header {}", path.display()))?;
    let vertex_def = header
        .elements
        .get("vertex")
        .ok_or_else(|| anyhow!("{} has no 'vertex' element", path.display()))?;
    let vertices = parser
        .read_payload_for_element(&mut reader, vertex_def, &header)
        .with_context(|| format!("read vertex payload {}", path.display()))?;

    let mut points = Vec::with_capacity(vertices.len());
    let mut colors = Vec::with_capacity(vertices.len());
    for v in vertices {
        let p = ds3_to_kiss3d_point(Vec3::new(v.x, v.y, v.z));
        points.push(p);
        let color = if v.has_color {
            Color::new(v.r as f32 / 255.0, v.g as f32 / 255.0, v.b as f32 / 255.0, 1.0)
        } else {
            WHITE
        };
        colors.push(color);
    }

    Ok(PointCloud { source: path.to_path_buf(), points, colors, visible: true })
}

fn ds3_to_kiss3d_point(p: Vec3) -> Vec3 {
    // Convert left-handed (+Z forward) DS3 world points to right-handed view space for kiss3d.
    Vec3::new(p.x, p.y, -p.z)
}

fn short_cloud_name(path: &Path) -> String {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    if let Some((_, rest)) = stem.split_once(".exe ") {
        return rest.to_string();
    }
    if let Some((_, rest)) = stem.split_once("exe ") {
        return rest.to_string();
    }
    stem.to_string()
}

fn property_to_f32(p: &Property) -> Option<f32> {
    match p {
        Property::Float(x) => Some(*x),
        Property::Double(x) => Some(*x as f32),
        Property::Int(x) => Some(*x as f32),
        Property::UInt(x) => Some(*x as f32),
        Property::Short(x) => Some(*x as f32),
        Property::UShort(x) => Some(*x as f32),
        Property::Char(x) => Some(*x as f32),
        Property::UChar(x) => Some(*x as f32),
        _ => None,
    }
}

fn property_to_u8(p: &Property) -> Option<u8> {
    match p {
        Property::UChar(x) => Some(*x),
        Property::Char(x) => Some((*x).max(0) as u8),
        Property::UShort(x) => Some((*x).min(255) as u8),
        Property::Short(x) => Some((*x).clamp(0, 255) as u8),
        Property::UInt(x) => Some((*x).min(255) as u8),
        Property::Int(x) => Some((*x).clamp(0, 255) as u8),
        Property::Float(x) => Some((*x).clamp(0.0, 255.0) as u8),
        Property::Double(x) => Some((*x as f32).clamp(0.0, 255.0) as u8),
        _ => None,
    }
}
