use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use kiss3d::camera::OrbitCamera3d;
use kiss3d::event::{Action, Key, WindowEvent};
use kiss3d::glamx::{Vec2, Vec3};
use kiss3d::prelude::{Color, Font, SceneNode3d, Window, BLACK, GREEN, RED, WHITE};
use ply_rs::parser::Parser;
use ply_rs::ply::{Property, PropertyAccess};
use rfd::FileDialog;

#[derive(Clone)]
struct PointCloud {
    source: PathBuf,
    points: Vec<Vec3>,
    colors: Vec<Color>,
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

struct OverlayContext<'a> {
    clouds: &'a [PointCloud],
    point_size: f32,
    status: &'a str,
    camera: &'a OrbitCamera3d,
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
    let mut status = "Press O to import PLY files. Press F to fit all loaded points.".to_string();
    let mut point_size = 1.0_f32;
    let font = Font::default();

    while kiss3d::pollster::block_on(window.render_3d(&mut scene, &mut perspective)) {
        for event in window.events().iter() {
            if let WindowEvent::Key(key, Action::Release, _) = event.value {
                match key {
                    Key::O => {
                        if let Some(paths) =
                            FileDialog::new().add_filter("PLY", &["ply"]).pick_files()
                        {
                            let mut ok = 0usize;
                            let mut failed = 0usize;
                            for p in paths {
                                match load_ply_points(&p) {
                                    Ok(c) => {
                                        clouds.push(c);
                                        ok += 1;
                                    },
                                    Err(_) => failed += 1,
                                }
                            }
                            status = format!(
                                "Imported {ok} file(s), failed {failed}. Total clouds: {}",
                                clouds.len()
                            );
                        }
                    },
                    Key::X => {
                        clouds.clear();
                        status = "Scene cleared.".to_string();
                    },
                    Key::F => {
                        if center_all_points(&clouds, &mut perspective) {
                            status = "Centered view to all loaded points.".to_string();
                        } else {
                            status = "No points to center.".to_string();
                        }
                    },
                    Key::LBracket => point_size = (point_size - 0.25).max(1.0),
                    Key::RBracket => point_size = (point_size + 0.25).min(10.0),
                    Key::Minus => perspective.set_fov(
                        (perspective.fov() - 2_f32.to_radians())
                            .clamp(5_f32.to_radians(), 120_f32.to_radians()),
                    ),
                    Key::Equals => perspective.set_fov(
                        (perspective.fov() + 2_f32.to_radians())
                            .clamp(5_f32.to_radians(), 120_f32.to_radians()),
                    ),
                    _ => {},
                }
            }
        }

        apply_keyboard_camera_controls(&window, &mut perspective);
        for cloud in &clouds {
            for (idx, point) in cloud.points.iter().enumerate() {
                let color = cloud.colors.get(idx).copied().unwrap_or(WHITE);
                window.draw_point(*point, color, point_size);
            }
        }

        let overlay = OverlayContext {
            clouds: &clouds,
            point_size,
            status: &status,
            camera: &perspective,
        };
        draw_overlay(&mut window, &font, &overlay);
    }

    Ok(())
}

fn apply_keyboard_camera_controls(
    window: &Window,
    perspective: &mut OrbitCamera3d,
) {
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

fn draw_overlay(window: &mut Window, font: &std::sync::Arc<Font>, ctx: &OverlayContext<'_>) {
    let total_points: usize = ctx.clouds.iter().map(|c| c.points.len()).sum();
    let params = format!("fov={:.1}deg", ctx.camera.fov().to_degrees());

    let help = [
        "O: open PLY files (multi-select)",
        "X: clear scene",
        "F: fit/center all loaded points",
        "WASDQE: move target   Z/C: zoom",
        "[ / ]: point size",
        "- / =: fov",
        "Mouse: orbit/drag/scroll (OrbitCamera3d controls)",
    ];

    window.draw_text(
        &format!(
            "Mode: Perspective | {params} | Clouds: {} | Points: {} | PointSize: {:.2}",
            ctx.clouds.len(),
            total_points,
            ctx.point_size
        ),
        Vec2::new(10.0, 10.0),
        22.0,
        font,
        WHITE,
    );
    window.draw_text(ctx.status, Vec2::new(10.0, 36.0), 20.0, font, GREEN);

    let mut y = 64.0;
    for line in help {
        window.draw_text(line, Vec2::new(10.0, y), 18.0, font, RED);
        y += 18.0;
    }

    let mut file_y = y + 8.0;
    for cloud in ctx.clouds.iter().take(6) {
        let label = format!("- {} ({} pts)", cloud.source.display(), cloud.points.len());
        window.draw_text(&label, Vec2::new(10.0, file_y), 16.0, font, BLACK);
        file_y += 16.0;
    }
}

fn center_all_points(
    clouds: &[PointCloud],
    perspective: &mut OrbitCamera3d,
) -> bool {
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
        let p = Vec3::new(v.x, v.y, v.z);
        points.push(p);
        let color = if v.has_color {
            Color::new(v.r as f32 / 255.0, v.g as f32 / 255.0, v.b as f32 / 255.0, 1.0)
        } else {
            WHITE
        };
        colors.push(color);
    }

    Ok(PointCloud { source: path.to_path_buf(), points, colors })
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
