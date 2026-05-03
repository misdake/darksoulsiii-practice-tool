# Dark Souls III Map

This repository is evolving from a practice overlay into a DS3 minimap pipeline with two core components:

- `ds3-map-probe`: screenshot/depth capture helper used to collect RGB + depth + camera metadata.
- `ds3-map-viewer`: in-game map display and interaction layer.

The current direction is:

1. Build a reliable capture pipeline in-game (`ds3-map-probe`).
2. Validate point-cloud reconstruction from RGB + depth.
3. Scale to tile/layer export for minimap assets.
4. Render filtered, interactive minimap content in-game (`ds3-map-viewer`).

![Screenshot](lib/data/screenshot.jpg)

## Workspace layout

- `ds3-map-probe`: capture tooling, camera/game-state initialization, metadata recording.
- `ds3-map-viewer`: game overlay, map rendering, and UI interaction.
- `lib`: shared code and assets.
- `xtask`: developer automation tasks.

## Current roadmap

The immediate workstream matches the DS3 minimap plan:

1. **Capture assistant (`ds3-map-probe`)**
   Coordinate with ReShade, initialize game/camera state, capture RGB+depth, and persist metadata.
2. **Point-cloud validation**
   Read EXR depth, implement unprojection, generate previewable point clouds, verify geometric correctness.
3. **Point-cloud production**
   Handle larger datasets, export tile images, and support layer metadata for downstream minimap rendering.

## Getting started

Download the **latest stable release** [here](https://github.com/veeenu/ds3-map/releases/latest).

Prerequisites:

- Steam must be open. Offline mode is fine, but the program must be started.
- Antiviruses are disabled. This includes Windows Defender. If you don't want to do that, make sure to whitelist the contents of the practice tool in your antivirus.
- You have a legitimate copy of the game. Pirated copies will never be supported.

## Running the viewer

### Standalone

- Extract all files from the zip archive. Anywhere will do.
- Start Dark Souls III.
- Double-click `ds3_map_viewer.exe`.

`ds3-map-viewer` will automatically appear over the game. Press `0` to open and close its interface.

### Installed

- Extract all files from the zip archive.
- Rename `ds3_map_viewer.dll` to `dinput8.dll`. Make sure your [file extensions are visible](https://www.howtogeek.com/205086/beginner-how-to-make-windows-show-file-extensions/)
  to ensure you are naming the file correctly.
- Copy `dinput8.dll` and `ds3_map_viewer.toml` to your Dark Souls III `Game` folder.
  The files must be in the same folder as `DarkSoulsIII.exe`.
- Start Dark Souls III normally.

The viewer is now installed. To load it, start the game, press the right shift button and keep it pressed for a few seconds until the tool appears on screen.

If you don't do that, the tool won't load and the game will start normally.

## Running on Linux

The viewer supports Linux and should run on Steam Deck.

### Standalone

If you want to run the tool in a standalone fashion, I recommend [protontricks](https://github.com/Matoking/protontricks):

```sh
protontricks-launch --appid 374320 ds3_map_viewer.exe
```

### Installed

Follow the same instructions as above. Additionally, set the launch options in Steam as follows:

```sh
WINEDLLOVERRIDES="dinput8=n,b" %command%
```

## Help

If the tool doesn't work, you need help, or want to get in touch, read the [troubleshooting guide](TROUBLESHOOTING.md).

If you are looking to submit a patch, check the [contributing guide](CONTRIBUTING.md).

## Credits

- ViRazY for the invaluable help in figuring out Linux support.
- Pav, wasted, jamesq7 for technical help in figuring things out.
- The Cheat Engine table maintained by [The Grand Archives](https://github.com/inunorii/Dark-Souls-III-CT-TGA)
  provided the research base for many of the pointers used in the tool.
- NamelessHoodie[2] and Amir's work on [HoodieScript](https://github.com/NamelessHoodie/HoodieScript)
  for insights about the game's inner workings.
- The Soulsmodding community for the [Param definitions](https://github.com/soulsmods/Paramdex).
- r3sus for the help with anti-cheat ideas, for all the interesting study material / code and
  all the general tips.
- The font used in the UI is [Comic Mono](https://github.com/dtinth/comic-mono-font).
