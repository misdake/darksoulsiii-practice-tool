use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use kiss3d::camera::{Camera3d, OrbitCamera3d};
use kiss3d::event::{Action, Key, WindowEvent};
use kiss3d::glamx::{Mat4, Pose3, Vec2, Vec3};
use kiss3d::prelude::{Color, Font, SceneNode3d, Window, BLACK, GREEN, RED, WHITE};
use kiss3d::procedural::RenderMesh;
use ply_rs::parser::Parser;
use ply_rs::ply::{Property, PropertyAccess};
use rfd::FileDialog;

#[derive(Clone)]
struct PointCloud {
    source: PathBuf,
    points: Vec<Vec3>,
    nodes: Vec<SceneNode3d>,
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
            }
            "green" | "g" => {
                if let Some(v) = property_to_u8(&property) {
                    self.g = v;
                    self.has_color = true;
                }
            }
            "blue" | "b" => {
                if let Some(v) = property_to_u8(&property) {
                    self.b = v;
                    self.has_color = true;
                }
            }
            _ => {}
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProjectionMode {
    Perspective,
    Orthographic,
}

struct OrthoOrbitCamera {
    orbit: OrbitCamera3d,
    ortho_scale: f32,
    znear: f32,
    zfar: f32,
    last_framebuffer_size: Vec2,
    proj: Mat4,
    proj_view: Mat4,
    inv_proj_view: Mat4,
}

impl OrthoOrbitCamera {
    fn new_from_orbit(orbit: OrbitCamera3d) -> Self {
        let mut cam = Self {
            orbit,
            ortho_scale: 10.0,
            znear: 0.1,
            zfar: 10_000.0,
            last_framebuffer_size: Vec2::new(800.0, 600.0),
            proj: Mat4::IDENTITY,
            proj_view: Mat4::IDENTITY,
            inv_proj_view: Mat4::IDENTITY,
        };
        cam.update_matrices();
        cam
    }

    fn update_matrices(&mut self) {
        let aspect = (self.last_framebuffer_size.x / self.last_framebuffer_size.y).max(1.0e-6);
        let half_h = self.ortho_scale.max(1.0e-3);
        let half_w = half_h * aspect;
        self.proj =
            Mat4::orthographic_rh_gl(-half_w, half_w, -half_h, half_h, self.znear, self.zfar);
        let view = self.orbit.view_transform().to_mat4();
        self.proj_view = self.proj * view;
        self.inv_proj_view = self.proj_view.inverse();
    }

    fn set_ortho_scale(&mut self, value: f32) {
        self.ortho_scale = value.clamp(0.01, 1_000_000.0);
        self.update_matrices();
    }

    fn set_clip_planes(&mut self, znear: f32, zfar: f32) {
        self.znear = znear.max(0.0001);
        self.zfar = zfar.max(self.znear + 0.01);
        self.update_matrices();
    }
}

impl Camera3d for OrthoOrbitCamera {
    fn handle_event(&mut self, canvas: &kiss3d::window::Canvas, event: &WindowEvent) {
        self.orbit.handle_event(canvas, event);
        if let WindowEvent::FramebufferSize(w, h) = *event {
            self.last_framebuffer_size = Vec2::new(w as f32, h as f32);
        }
        self.update_matrices();
    }

    fn eye(&self) -> Vec3 {
        self.orbit.eye()
    }

    fn view_transform(&self) -> Pose3 {
        self.orbit.view_transform()
    }

    fn transformation(&self) -> Mat4 {
        self.proj_view
    }

    fn inverse_transformation(&self) -> Mat4 {
        self.inv_proj_view
    }

    fn clip_planes(&self) -> (f32, f32) {
        (self.znear, self.zfar)
    }

    fn update(&mut self, canvas: &kiss3d::window::Canvas) {
        self.orbit.update(canvas);
        self.update_matrices();
    }

    fn view_transform_pair(&self, _pass: usize) -> (Pose3, Mat4) {
        (self.orbit.view_transform(), self.proj)
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
    perspective.set_fov(45_f32.to_radians());
    let mut orthographic = OrthoOrbitCamera::new_from_orbit(perspective);
    let mut scene = SceneNode3d::empty();

    let mut projection = ProjectionMode::Perspective;
    let mut clouds: Vec<PointCloud> = Vec::new();
    let mut status: String;
    let mut point_size = 1.0_f32;
    let font = Font::default();

    let debug = create_debug_cloud(&mut scene, point_size);
    clouds.push(debug);
    status = "Debug cloud loaded at origin. Press F to center, then O to import PLY.".to_string();

    while {
        match projection {
            ProjectionMode::Perspective => {
                kiss3d::pollster::block_on(window.render_3d(&mut scene, &mut perspective))
            }
            ProjectionMode::Orthographic => {
                kiss3d::pollster::block_on(window.render_3d(&mut scene, &mut orthographic))
            }
        }
    } {
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
                                match load_ply_points(&p, &mut scene, point_size) {
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
                        for cloud in &mut clouds {
                            for node in &mut cloud.nodes {
                                node.remove();
                            }
                        }
                        clouds.clear();
                        status = "Scene cleared.".to_string();
                    },
                    Key::F => {
                        if center_all_points(&clouds, &mut perspective, &mut orthographic) {
                            status = "Centered view to all loaded points.".to_string();
                        } else {
                            status = "No points to center.".to_string();
                        }
                    },
                    Key::M => {
                        projection = match projection {
                            ProjectionMode::Perspective => {
                                orthographic.orbit = perspective;
                                orthographic.update_matrices();
                                ProjectionMode::Orthographic
                            },
                            ProjectionMode::Orthographic => {
                                perspective = orthographic.orbit;
                                ProjectionMode::Perspective
                            },
                        };
                        status = match projection {
                            ProjectionMode::Perspective => {
                                "Switched to perspective camera.".to_string()
                            },
                            ProjectionMode::Orthographic => {
                                "Switched to orthographic camera.".to_string()
                            },
                        };
                    },
                    Key::LBracket => point_size = (point_size - 0.25).max(1.0),
                    Key::RBracket => point_size = (point_size + 0.25).min(10.0),
                    Key::Minus => {
                        if projection == ProjectionMode::Perspective {
                            perspective.set_fov(
                                (perspective.fov() - 2_f32.to_radians())
                                    .clamp(5_f32.to_radians(), 120_f32.to_radians()),
                            );
                        } else {
                            orthographic.set_ortho_scale(orthographic.ortho_scale * 1.1);
                        }
                    },
                    Key::Equals => {
                        if projection == ProjectionMode::Perspective {
                            perspective.set_fov(
                                (perspective.fov() + 2_f32.to_radians())
                                    .clamp(5_f32.to_radians(), 120_f32.to_radians()),
                            );
                        } else {
                            orthographic.set_ortho_scale(orthographic.ortho_scale / 1.1);
                        }
                    },
                    Key::Comma => {
                        if projection == ProjectionMode::Orthographic {
                            orthographic.set_clip_planes(
                                (orthographic.znear * 0.9).max(0.0001),
                                orthographic.zfar,
                            );
                        }
                    },
                    Key::Period => {
                        if projection == ProjectionMode::Orthographic {
                            orthographic.set_clip_planes(
                                (orthographic.znear * 1.1).max(0.0001),
                                orthographic.zfar,
                            );
                        }
                    },
                    Key::Semicolon => {
                        if projection == ProjectionMode::Orthographic {
                            orthographic.set_clip_planes(
                                orthographic.znear,
                                (orthographic.zfar * 0.9).max(orthographic.znear + 0.01),
                            );
                        }
                    },
                    Key::Apostrophe => {
                        if projection == ProjectionMode::Orthographic {
                            orthographic
                                .set_clip_planes(orthographic.znear, orthographic.zfar * 1.1);
                        }
                    },
                    _ => {},
                }
            }
        }

        apply_keyboard_camera_controls(&window, projection, &mut perspective, &mut orthographic);
        for cloud in &mut clouds {
            for node in &mut cloud.nodes {
                node.set_points_size(point_size, false);
            }
        }

        draw_overlay(
            &mut window,
            &font,
            projection,
            &clouds,
            point_size,
            &status,
            &perspective,
            &orthographic,
        );
    }

    Ok(())
}

fn create_debug_cloud(scene: &mut SceneNode3d, point_size: f32) -> PointCloud {
    let step = 0.25_f32;
    let mut points = Vec::new();
    for i in -4..=4 {
        points.push(Vec3::new(i as f32 * step, 0.0, 0.0));
        points.push(Vec3::new(0.0, i as f32 * step, 0.0));
        points.push(Vec3::new(0.0, 0.0, i as f32 * step));
    }
    points.push(Vec3::new(0.0, 0.0, 0.0));

    let render_mesh = RenderMesh::new(
        points.clone(),
        None,
        None,
        None,
    );
    let mut node = scene.add_render_mesh(render_mesh, Vec3::ONE);
    node.set_surface_rendering_activation(false);
    node.set_points_size(point_size.max(2.0), false);
    node.set_points_color(Some(WHITE));

    PointCloud {
        source: PathBuf::from("[debug-origin-cloud]"),
        points,
        nodes: vec![node],
    }
}

fn apply_keyboard_camera_controls(
    window: &Window,
    mode: ProjectionMode,
    perspective: &mut OrbitCamera3d,
    orthographic: &mut OrthoOrbitCamera,
) {
    let speed = 0.15_f32;
    let zoom_factor = 1.02_f32;
    match mode {
        ProjectionMode::Perspective => {
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
        },
        ProjectionMode::Orthographic => {
            let mut t = orthographic.orbit.at();
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
            orthographic.orbit.set_at(t);

            let mut d = orthographic.orbit.dist();
            if window.get_key(Key::Z) == Action::Press {
                d *= zoom_factor;
            }
            if window.get_key(Key::C) == Action::Press {
                d /= zoom_factor;
            }
            orthographic.orbit.set_dist(d.max(0.001));
            orthographic.update_matrices();
        },
    }
}

fn draw_overlay(
    window: &mut Window,
    font: &std::sync::Arc<Font>,
    projection: ProjectionMode,
    clouds: &[PointCloud],
    point_size: f32,
    status: &str,
    perspective: &OrbitCamera3d,
    orthographic: &OrthoOrbitCamera,
) {
    let total_points: usize = clouds.iter().map(|c| c.points.len()).sum();
    let mode_text = match projection {
        ProjectionMode::Perspective => "Perspective",
        ProjectionMode::Orthographic => "Orthographic",
    };

    let params = match projection {
        ProjectionMode::Perspective => format!("fov={:.1}deg", perspective.fov().to_degrees()),
        ProjectionMode::Orthographic => format!(
            "scale={:.3}, near={:.3}, far={:.1}",
            orthographic.ortho_scale, orthographic.znear, orthographic.zfar
        ),
    };

    let help = [
        "O: open PLY files (multi-select)",
        "X: clear scene",
        "F: fit/center all loaded points",
        "M: toggle perspective/orthographic",
        "WASDQE: move target   Z/C: zoom",
        "[ / ]: point size",
        "- / =: fov (persp) or scale (ortho)",
        ", / .: near -/+ (ortho)",
        "; / ': far -/+ (ortho)",
        "Mouse: orbit/drag/scroll (OrbitCamera3d controls)",
    ];

    window.draw_text(
        &format!(
            "Mode: {mode_text} | {params} | Clouds: {} | Points: {} | PointSize: {:.2}",
            clouds.len(),
            total_points,
            point_size
        ),
        Vec2::new(10.0, 10.0),
        22.0,
        font,
        WHITE,
    );
    window.draw_text(status, Vec2::new(10.0, 36.0), 20.0, font, GREEN);

    let mut y = 64.0;
    for line in help {
        window.draw_text(line, Vec2::new(10.0, y), 18.0, font, RED);
        y += 18.0;
    }

    let mut file_y = y + 8.0;
    for cloud in clouds.iter().take(6) {
        let label = format!("- {} ({} pts)", cloud.source.display(), cloud.points.len());
        window.draw_text(&label, Vec2::new(10.0, file_y), 16.0, font, BLACK);
        file_y += 16.0;
    }
}

fn center_all_points(
    clouds: &[PointCloud],
    perspective: &mut OrbitCamera3d,
    orthographic: &mut OrthoOrbitCamera,
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

    orthographic.orbit.set_at(center);
    orthographic.orbit.set_dist((radius * 2.5).max(2.0));
    orthographic.set_ortho_scale((radius * 1.2).max(1.0));

    true
}

fn load_ply_points(path: &Path, scene: &mut SceneNode3d, point_size: f32) -> Result<PointCloud> {
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
    let mut buckets: HashMap<u32, Vec<Vec3>> = HashMap::new();
    for v in vertices {
        let p = Vec3::new(v.x, v.y, v.z);
        points.push(p);
        let key = if v.has_color {
            ((v.r as u32) << 16) | ((v.g as u32) << 8) | (v.b as u32)
        } else {
            0xFFFFFF
        };
        buckets.entry(key).or_default().push(p);
    }

    let mut nodes = Vec::with_capacity(buckets.len());
    for (rgb, pts) in buckets {
        let render_mesh = RenderMesh::new(pts, None, None, None);
        let mut node = scene.add_render_mesh(render_mesh, Vec3::ONE);
        node.set_surface_rendering_activation(false);
        node.set_points_size(point_size, false);
        let r = ((rgb >> 16) & 0xFF) as f32 / 255.0;
        let g = ((rgb >> 8) & 0xFF) as f32 / 255.0;
        let b = (rgb & 0xFF) as f32 / 255.0;
        node.set_points_color(Some(Color::new(r, g, b, 1.0)));
        nodes.push(node);
    }

    Ok(PointCloud {
        source: path.to_path_buf(),
        points,
        nodes,
    })
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
