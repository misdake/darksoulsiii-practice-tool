# ds3-map-planner

`ds3-map-planner` is the planning-side crate for map capture workflow.

Current scope includes:

- preparation pipeline docs
- Stage 1 local server + web viewer (`collision`/`navmesh` import + filter + persist)

## Preparation Pipeline (m40_00_00_00)

Assume these external-tool environment variables are set before running:

- `TOOL_BINDER={your absolute path to bindertool.exe}`
- `TOOL_HKX_EXPORTER_PROJECT={your absolute path to DS3CollisionExport/src/hkx-exporter/hkx-exporter.csproj}`
- `TOOL_NAVMESH_EXPORTER_PROJECT={your absolute path to DS3CollisionExport/src/navmesh-exporter/navmesh-exporter.csproj}`
- `GAME_MAP_M40_DIR={your absolute path to DARK SOULS III/Game/map/m40_00_00_00}`

Other paths below are project constants using **relative paths** (relative to workspace root).

### Constants

- `INPUT_MSB=ds3map/mapstudio/m40_00_00_00.msb.dcx`
- `OUT_ROOT=map-work/capture-planner/m40_00_00_00`
- `OUT_UNPACK=map-work/capture-planner/m40_00_00_00/unpack`
- `OUT_HKX_DIR=map-work/capture-planner/m40_00_00_00/unpack/m40_00_00_00`
- `OUT_COLLISION_OBJ_DIR=map-work/capture-planner/m40_00_00_00/collision_objs`
- `OUT_COLLISION_JSON=map-work/capture-planner/m40_00_00_00/collision_world.json`
- `OUT_NAVMESH_OBJ_DIR=map-work/capture-planner/m40_00_00_00/navmesh_objs`
- `OUT_NAVMESH_JSON=map-work/capture-planner/m40_00_00_00/navmesh_manifest.json`

### 1) Unpack collision binder (h40)

Inputs:

- `${GAME_MAP_M40_DIR}/h40_00_00_00.hkxbdt`
- `${GAME_MAP_M40_DIR}/h40_00_00_00.hkxbhd`

Example:

```powershell
& $TOOL_BINDER "${GAME_MAP_M40_DIR}/h40_00_00_00.hkxbdt" $OUT_UNPACK
```

### 2) Export collision OBJ + manifest

Inputs:

- HKX dir: `${OUT_HKX_DIR}`
- MSB: `${INPUT_MSB}`

Outputs:

- `${OUT_COLLISION_OBJ_DIR}/*.obj`
- `${OUT_COLLISION_JSON}`

### 3) Export navmesh OBJ + manifest (n40)

Inputs:

- `${GAME_MAP_M40_DIR}/m40_00_00_00.nvmhktbnd.dcx`
- `${GAME_MAP_M40_DIR}/m40_00_00_00.nva.dcx` (for transform)

Outputs:

- `${OUT_NAVMESH_OBJ_DIR}/*.obj`
- `${OUT_NAVMESH_JSON}`

## Next Planned Stages

### Stage 1: Import + Filter + Persist

Goal:

- Web loads collision/navmesh OBJ manifests.
- User manually filters collision/navmesh in viewer.
- Rust service persists filter selections.

Input:

- `collision_world.json`
- `navmesh_manifest.json`

Output:

- `filter_profile.json`
  - enabled/disabled collision IDs
  - enabled/disabled navmesh IDs
  - optional manual tags/notes

### Run Stage 1 Server

From workspace root:

```powershell
cargo run -p ds3-map-planner
```

Behavior:

- hosts web static files from `ds3-map-planner/web`
- hosts `map-work/*` static data at `/map-work/*` (for manifests/OBJ loading)
- serves APIs under `/api/*`
- opens `http://127.0.0.1:7878/` on startup

### Stage 2: Layering + Edit + Persist

Goal:

- Rust service computes initial layer split from filtered data.
- Web displays layer result and allows manual edits.
- Rust service persists edited layer profile.

Input:

- `filter_profile.json`
- filtered collision/navmesh geometry

Output:

- `layer_profile.json`
  - `layer_id`
  - layer bounds (`z` range + AABB)
  - navmesh membership
  - collision roof/occluder membership
  - optional per-layer camera overrides

### Stage 3: Screenshot Planning + Review + Export

Goal:

- Rust service computes layer-aware screenshot plan.
- Web visualizes plan, supports review and optional edits.
- Plan is exported for `probe`, with layer info preserved.

Input:

- `layer_profile.json`
- filtered geometry

Output:

- `shot_plan.json`
  - layer-aware waypoints/camera params
  - constraints/score metadata
  - downstream fields for `probe`

### Downstream Integration

1. `probe` consumes `capture_plan.json` for capture execution.
2. `processor` consumes layer information for map processing steps.
