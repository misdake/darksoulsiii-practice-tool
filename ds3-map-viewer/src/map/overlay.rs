#![allow(dead_code)]

use std::sync::Mutex;

use once_cell::sync::Lazy;

// player_arrow.svg uses the canvas center as anchor.
pub const PLAYER_ARROW_PIVOT: [f32; 2] = [0.5, 0.5];
// marker_default.svg tip is at y=94 on a 96px canvas => 94 / 96 = 0.9791667.
pub const MARKER_DEFAULT_PIVOT: [f32; 2] = [0.5, 94.0 / 96.0];

#[derive(Clone)]
pub enum OverlayItem {
    Icon {
        icon: String,
        world_xz: [f32; 2],
        size_wu: [f32; 2],
        pivot: [f32; 2],
        color: [f32; 4],
    },
    Text {
        world_xz: [f32; 2],
        text: String,
        color: [f32; 4],
        size_wu: [f32; 2],
        pivot: [f32; 2],
    },
    IconText {
        icon: String,
        world_xz: [f32; 2],
        text: String,
        color: [f32; 4],
        icon_size_wu: [f32; 2],
        spacing_px: f32,
    },
}

static OVERLAY_ITEMS: Lazy<Mutex<Vec<OverlayItem>>> = Lazy::new(|| Mutex::new(Vec::new()));

pub fn add_icon(
    icon: impl Into<String>,
    world_xz: [f32; 2],
    size_wu: [f32; 2],
    pivot: [f32; 2],
    color: [f32; 4],
) {
    if let Ok(mut items) = OVERLAY_ITEMS.lock() {
        items.push(OverlayItem::Icon {
            icon: icon.into(),
            world_xz,
            size_wu,
            pivot,
            color,
        });
    }
}

pub fn add_default_marker(world_xz: [f32; 2], size_wu: [f32; 2], color: [f32; 4]) {
    add_icon("default", world_xz, size_wu, MARKER_DEFAULT_PIVOT, color);
}

pub fn add_text(
    world_xz: [f32; 2],
    text: impl Into<String>,
    color: [f32; 4],
    size_wu: [f32; 2],
    pivot: [f32; 2],
) {
    if let Ok(mut items) = OVERLAY_ITEMS.lock() {
        items.push(OverlayItem::Text { world_xz, text: text.into(), color, size_wu, pivot });
    }
}

pub fn add_icon_text(
    icon: impl Into<String>,
    world_xz: [f32; 2],
    text: impl Into<String>,
    color: [f32; 4],
    icon_size_wu: [f32; 2],
    spacing_px: f32,
) {
    if let Ok(mut items) = OVERLAY_ITEMS.lock() {
        items.push(OverlayItem::IconText {
            icon: icon.into(),
            world_xz,
            text: text.into(),
            color,
            icon_size_wu,
            spacing_px,
        });
    }
}

pub fn take_frame_items() -> Vec<OverlayItem> {
    if let Ok(mut items) = OVERLAY_ITEMS.lock() {
        return std::mem::take(&mut *items);
    }
    Vec::new()
}
