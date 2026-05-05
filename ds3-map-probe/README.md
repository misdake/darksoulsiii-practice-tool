# DS3 Screenshot Capture Guide

This document describes the preparation steps and the in-game capture workflow for RGB + depth screenshots used by the DS3 minimap pipeline.

## Goal

Capture paired RGB and linear depth images, and save matching camera metadata for each shot.

## Prerequisites

- Dark Souls III installed and launchable.
- ReShade installed for `DarkSoulsIII.exe`.
- ReShade depth export addon + shader files installed.
  - Put the addon DLL next to `DarkSoulsIII.exe`.
  - Put the `.fx` files in the ReShade shader directory.
- `ds3-map-probe` injected into the game (`ds3_map_probe.exe` injector or `dinput8.dll` load path).

## ReShade Setup

- Enable the depth capture addon in ReShade.
- Set non linear depth in fx file.
- Set and verify depth/far-related settings before capture.
- Use the addon screenshot hotkey (`F10` in current notes).
- Expected raw outputs in the game exe folder:
  - `* BackBuffer.bmp`
  - `* DepthBuffer.exr`

## In-Game Preparation

Before batch capture, set a stable game state:

- Press `F9` to open probe UI.
- Set `Capture Subfolder` in UI (for example: `high_wall/layer0`).
  - Output root is auto-created at `<game_dir>/capture/<Capture Subfolder>`.
- Enable `AI Disable`.
- Disable `Render Character` to hide the player model.
- Toggle Free Camera with `F8`.
- Use `Reset Free Camera (F7)` to place camera above player and set a stable top-down orientation.
- Adjust `Fovy (rad)`, `Near`, and `Far` in UI if needed.

## Capture Workflow

1. Move free camera to the next tile position.
2. Press ReShade capture hotkey (`F10`) to generate one RGB+Depth pair in the game directory.
3. Press `F11` (or click `Process Latest Capture Pair`) in probe.
4. Probe will:
   - Find the latest complete `BackBuffer.bmp` + `DepthBuffer.exr` pair.
   - Move both files into `<game_dir>/capture/<Capture Subfolder>/`.
   - Write metadata TOML with the same prefix.
5. Repeat until area coverage is complete.

Optional:
- Press `F6` to teleport player to current camera position (with a small Y offset) if needed for map loading.

## Output Contract (Per Shot)

Each shot should produce one logical record:

- `prefix BackBuffer.bmp`
- `prefix DepthBuffer.exr`
- `prefix.toml`

Current metadata fields written by probe:

- `timestamp_unix`
- `rgb_file`
- `depth_file`
- `player_position`
- `camera_position`
- `camera_quat_wxyz`
- `camera_fov`
- `camera_near`
- `camera_far`

## Notes

- Free Camera control is provided by `ds3-map-probe`; CE is not required for the normal capture loop.
- Keep non-terrain visual noise hidden (player/enemy model, hud).
