# ds3-map-planner

`ds3-map-planner` is the planning-side crate for map capture workflow.

Current scope includes:

- preparation pipeline docs
- JS local server + web viewer (`collision`/`navmesh` import + staged persistence)
- browser-side shot-plan calculation and camera preview

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

### Active Stages

1. `Stage 1 Collision Filter` (on `/filters.html`)
2. `Stage 2 Nav Filter` (on `/filters.html`)
3. `Stage 3 Mark Nav` (on `/filters.html`, with physics + third-person/free camera + nav segment marking)
4. `Stage 4 Map Regions` (on `/regions.html`, including physical Test mode)
5. `Stage 5 Region Shot Plans` (on `/regions.html`)

### Persisted Stage Data

Each stage saves its raw JSON payload independently:

- `stage1_collision_filter.json`
- `stage2_nav_filter.json`
- `stage3_mark_nav.json`
- `stage4_map_regions.json`
- `stage5_map_region_shot_plans.json`

### Run Planner Server (JS)

Install the frontend dependencies once:

```powershell
cd ds3-map-planner/web
npm install
```

Then start the planner from its package directory:

```powershell
cd ds3-map-planner
npm run dev
```

The development command starts both processes:

- Vite serves and watches the web UI at `http://127.0.0.1:5173/`
- the Node backend serves APIs and map data at `http://127.0.0.1:7878/`
- hosts `map-work/*` static data at `/map-work/*` (for manifests/OBJ loading)
- Vite proxies `/api`, `/map-work`, and `/obj-worker.js` to the backend
- frontend changes use Vite HMR; no manual build is required

Environment overrides:

- `PLANNER_HOST` (default `127.0.0.1`)
- `PLANNER_PORT` (default `7878`)
- `PLANNER_WEB_ORIGIN` (default `http://127.0.0.1:5173`)
- `VITE_BACKEND_ORIGIN` (default `http://127.0.0.1:7878`)

### Web Development (Vite)

The HTML and JavaScript entry names match:

- `index.html` loads `index.js`
- `filters.html` loads `filters.js`
- `regions.html` loads `regions.js`

This internal tool only supports the Vite development workflow. The backend does
not serve `web/dist` or source frontend modules.

### Navmesh Split Tool (Rust)

`navmesh_split` stays as Rust bin for CPU-heavy mesh split:

```powershell
cargo run -p ds3-map-planner --bin navmesh_split -- m40_00_00_00
```

### Map Regions

The homepage at `/index.html` shows each map's persisted workflow progress and links to the two work pages. Save the Stage 3 nav selection in `/filters.html`, then open `/regions.html`. The region page edits region prisms, previews active regions through a clipped left map viewport, and creates per-region camera plans. The legacy `stage4_shot_plan.json` is not read by this workflow.

## Map region workflow

The filter page (`/filters.html`) contains Stage 1–3. The region page (`/regions.html`) contains Stage 4–5. Stage 4 provides Navmesh, Regions, and Test modes and stores regions in `stage4_map_regions.json`; Stage 5 stores regional camera plans in `stage5_map_region_shot_plans.json`. Runtime, persisted region data, physics, raycasts, and worker data all use the same right-handed world coordinates.
