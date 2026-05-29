# ds3-map-planner

`ds3-map-planner` is the planning-side crate for map capture workflow.

Current scope includes:

- preparation pipeline docs
- JS local server + web viewer (`collision`/`navmesh` import + filter + persist)
- active web stages: `Stage 1` / `Stage 2` / `Stage 3 (Terrain Adventure)`

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

### Active Stages

1. `Stage 1` Collision filtering
2. `Stage 2` Nav object filtering
3. `Stage 3` Terrain Adventure (physics + third-person/free camera + nav split marking by ground probe)

### Persisted Filter Profile

Goal:

- persist one profile file per map in `map-work/capture-planner/{map_id}/filter_profile.json`
- saved fields:
  - `visibility.collision_enabled_paths`
  - `visibility.navmesh_enabled_paths`
  - `selection.selected_nav_segments` (`{ nav_name, segment_index }`, where `nav_name` is the split OBJ path)

### Run Stage 1 Server (JS)

From workspace root:

```powershell
node ds3-map-planner/server.js
# or:
# cd ds3-map-planner
# npm start
```

Behavior:

- hosts web static files from `ds3-map-planner/web`
- hosts `map-work/*` static data at `/map-work/*` (for manifests/OBJ loading)
- serves APIs under `/api/*`
- opens `http://127.0.0.1:7878/` on startup

Environment overrides:

- `PLANNER_HOST` (default `127.0.0.1`)
- `PLANNER_PORT` (default `7878`)
- `PLANNER_OPEN_BROWSER=0` to disable auto-open

### Web Dev (Vite + TypeScript)

Install frontend deps:

```powershell
cd ds3-map-planner/web
npm install
```

Run Vite dev server:

```powershell
npm run dev
```

Then open:

- `http://127.0.0.1:5173/`

Notes:

- Vite proxies `/api` and `/map-work` to `http://127.0.0.1:7878` by default.
- Run backend server (`node ds3-map-planner/server.js`) in another terminal.

Build frontend:

```powershell
cd ds3-map-planner/web
npm run build
```

After build, backend server auto-serves `ds3-map-planner/web/dist` (if present), otherwise falls back to source `web/`.

### Navmesh Split Tool (Rust)

`navmesh_split` stays as Rust bin for CPU-heavy mesh split:

```powershell
cargo run -p ds3-map-planner --bin navmesh_split -- m40_00_00_00
```

### Future Planning

Layering/screenshot-planning stages remain future work and are not implemented in current web UI.
