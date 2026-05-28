import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSM } from "three/addons/csm/CSM.js";
import { StageManager } from "./stages/stage-manager.js";
import { DEFAULT_STAGE_ID, createPlannerStageDefinitions } from "./stages/stage-definitions.js";
import { PhysicsSystem } from "./systems/physics-system.js";
import { ThirdPersonControllerSystem } from "./systems/third-person-controller-system.js";
import { NavProbeSystem } from "./systems/nav-probe-system.js";
import { CollisionSystem } from "./systems/collision-system.js";
import { NavSystem } from "./systems/nav-system.js";

const app = document.getElementById("app");
const mapSelectEl = document.getElementById("mapSelect");
const fitBtn = document.getElementById("fitBtn");
const resetVisibleBtn = document.getElementById("resetVisibleBtn");
const resetNavSegmentBtn = document.getElementById("resetNavSegmentBtn");
const saveBtn = document.getElementById("saveBtn");
const cameraModeBtn = document.getElementById("cameraModeBtn");
const collisionListEl = document.getElementById("collisionList");
const navmeshListEl = document.getElementById("navmeshList");
const hitFilterListEl = document.getElementById("hitFilterList");
const statusEl = document.getElementById("status");
const loadProgressTextEl = document.getElementById("loadProgressText");
const loadProgressPctEl = document.getElementById("loadProgressPct");
const loadProgressFillEl = document.getElementById("loadProgressFill");
const loadProgressWrapEl = document.getElementById("loadProgressWrap");
const stageRadioEls = Array.from(document.querySelectorAll('input[name="stage"]'));
const stageLabelEls = new Map(Array.from(document.querySelectorAll("[data-stage-label]")).map((el) => [Number(el.getAttribute("data-stage-label")), el]));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1115);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 3000);
camera.position.set(100, 80, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
controls.mouseButtons.MIDDLE = null;
const pickRaycaster = new THREE.Raycaster();

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 0.5);
dir.position.set(120, 220, 100);
scene.add(dir);

const root = new THREE.Group();
scene.add(root);
const clock = new THREE.Clock();

const csm = new CSM({
  camera,
  parent: scene,
  cascades: 4,
  maxFar: 2000,
  mode: "practical",
  shadowMapSize: 2048,
  lightDirection: new THREE.Vector3(-0.6, -1.0, -0.45).normalize(),
  lightIntensity: 1.0,
  lightNear: 1,
  lightFar: 2200,
  fade: true,
});

const APPLY_Z_FLIP = true;
const COLLISION_BASE_COLOR = 0x94a3b8;
const COLLISION_HIGHLIGHT_COLOR = 0xc7d2e2;
const NAV_STATE_COLORS = { unset: 0xef5350, selected: 0xffffff };
const HIGHLIGHT_COLOR = 0xc7d2e2;
const HIDE_NAV_BY_COLLISION_HF = new Set([13, 14, 15]);
const HIT_FILTER_TYPE_LABELS = new Map([
  [0, "Standard: No High Collision - No Foot IK"],
  [1, "Standard: No High Collision"],
  [2, "Standard: No High Collision"],
  [3, "Standard: No High Collision"],
  [4, "Standard: No High Collision"],
  [5, "Standard: No High Collision"],
  [6, "Standard: No High Collision"],
  [7, "Standard: No High Collision"],
  [8, "Collide with all characters"],
  [9, "Collide with camera only"],
  [11, "Collide with non-player characters only"],
  [13, "Trigger fall death camera in collision"],
  [14, "Trigger fall death camera in collision"],
  [15, "Trigger instant death on collision"],
  [16, "Type 16"],
  [17, "Type 17"],
  [19, "Collide with non-player characters only"],
  [20, "Type 20"],
  [21, "Slide movement"],
  [22, "Block all fall damage"],
  [23, "Type 23"],
  [24, "Type 24"],
  [29, "Type 29"],
]);

let currentMapId = "";
let currentStage = DEFAULT_STAGE_ID;
let collisionGroup = null;
let navmeshGroup = null;
let selectedTarget = null;
let pointerDown = false;
let pointerDownX = 0;
let pointerDownY = 0;
let suppressNextClick = false;
let statusResetTimer = null;
let isReloading = false;
let queuedReload = false;
let currentDefaultHitFilterIds = [8];
let hasAppliedInitialStage = false;
const rowByKey = new Map();
const navSegmentUsageStates = new Map();
const runtime = {
  physicsState: {
    position: new THREE.Vector3(0, 3, 0),
    requestedMove: new THREE.Vector3(),
    verticalVelocity: 0,
    grounded: false,
    horizontalSpeed: 0,
  },
};
const physicsSystem = new PhysicsSystem();
const thirdPersonSystem = new ThirdPersonControllerSystem();
const navProbeSystem = new NavProbeSystem();
const collisionSystem = new CollisionSystem();
const navSystem = new NavSystem();
const stageRuntimeHooks = {
  onUpdateStage(_stageId, ctx, dt) {
    physicsSystem.update(ctx, dt);
    thirdPersonSystem.update(ctx, dt);
    navProbeSystem.update(ctx, dt);
  },
};
const stageManager = new StageManager(createPlannerStageDefinitions(stageRuntimeHooks), DEFAULT_STAGE_ID);
const EYE_VISIBLE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const EYE_HIDDEN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6c2.1 0 4 .6 5.5 1.5M22 12s-3.5 6-10 6c-2.1 0-4-.6-5.5-1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 4l16 16" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const EYE_PARTIAL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="1" y="3" width="10" height="18" fill="currentColor" fill-opacity="0.2"/></svg>';

function getStageConfig(stage = currentStage) {
  return stageManager.get(stage);
}

function normalizeStage(stage) {
  return stageManager.normalize(stage);
}

function setStatus(msg, isError = false, clearAfterMs = 0) {
  if (statusResetTimer) {
    clearTimeout(statusResetTimer);
    statusResetTimer = null;
  }
  statusEl.style.color = isError ? "#ff9f9f" : "#87f5b1";
  statusEl.textContent = msg;
  if (!isError && clearAfterMs > 0) {
    statusResetTimer = setTimeout(() => {
      statusEl.style.color = "#87f5b1";
      statusEl.textContent = "ready";
      statusResetTimer = null;
    }, clearAfterMs);
  }
}

function displayName(path) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function extractBlockKey(path) {
  const name = displayName(path || "");
  const m = name.match(/^[hn](\d{2}_\d{2}_\d{2}_\d{2}_\d{6})(?:__.*|\.obj)$/i);
  if (m) return m[1];
  return "";
}

function navSegKey(path, segmentIndex) {
  return `${path}::${segmentIndex}`;
}

function setLoadProgress(text, ratio, visible = true) {
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  const pctText = `${Math.round(clamped * 100)}%`;
  if (loadProgressWrapEl) loadProgressWrapEl.style.display = visible ? "" : "none";
  if (loadProgressTextEl) loadProgressTextEl.textContent = text;
  if (loadProgressPctEl) loadProgressPctEl.textContent = pctText;
  if (loadProgressFillEl) loadProgressFillEl.style.width = pctText;
}

function updateStageLabels() {
  for (const [id, el] of stageLabelEls.entries()) {
    const cfg = stageManager.get(id);
    el.textContent = cfg?.name || `Stage ${id}`;
  }
}


function normalizeSegmentState(state) {
  const s = String(state || "unset");
  if (s === "unmarked") return "unset";
  if (s === "keep") return "selected";
  if (s === "selected") return "selected";
  return "unset";
}

function getSegmentState(path, segmentIndex) {
  return getSegmentUsage(path, segmentIndex) ? "selected" : "unset";
}

function getSegmentUsage(path, segmentIndex) {
  return navSegmentUsageStates.get(navSegKey(path, segmentIndex)) === true;
}

function applyCollisionMaterial(group, opacity) {
  const effectiveOpacity = Math.min(Number(opacity), 0.9);
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.material = new THREE.MeshStandardMaterial({
      color: COLLISION_BASE_COLOR,
      roughness: 0.7,
      metalness: 0.0,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      opacity: effectiveOpacity,
      transparent: true,
      depthWrite: true,
    });
    csm.setupMaterial(obj.material);
  });
}

function makeNavMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0.0,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
  });
}

function applyNavVisuals() {
  navSystem.applyVisuals({
    selectedTarget,
    getSegmentState,
    getSegmentUsage,
    navStateColors: NAV_STATE_COLORS,
    highlightColor: HIGHLIGHT_COLOR,
  });
}

function applyCollisionVisuals() {
  collisionSystem.applySelectionVisual(selectedTarget, COLLISION_BASE_COLOR, COLLISION_HIGHLIGHT_COLOR);
}

function setSelectedTarget(target) {
  selectedTarget = target;
  highlightSelectedRow();
  applyCollisionVisuals();
  applyNavVisuals();
}

function clearSelection() {
  selectedTarget = null;
  highlightSelectedRow();
  applyCollisionVisuals();
  applyNavVisuals();
}

function highlightSelectedRow() {
  for (const row of rowByKey.values()) row.classList.remove("obj-item-selected");
  if (!selectedTarget) return;
  const key = selectedTarget.userData.rowKey;
  const row = rowByKey.get(key);
  if (!row) return;
  row.classList.add("obj-item-selected");
  row.scrollIntoView({ block: "nearest" });
}

async function fetchJson(url, opts) {
  const reqOpts = { cache: "no-cache", ...(opts || {}) };
  const res = await fetch(url, reqOpts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.json();
}

async function loadMapList() {
  const data = await fetchJson("/api/maps");
  mapSelectEl.innerHTML = "";
  for (const item of data.maps || []) {
    const mapId = typeof item === "string" ? item : item.map_id;
    const display = typeof item === "string" ? item : (item.display_name || item.map_id);
    if (!mapId) continue;
    const opt = document.createElement("option");
    opt.value = mapId;
    opt.textContent = `${mapId} - ${display}`;
    mapSelectEl.appendChild(opt);
  }
  if (!mapSelectEl.value && mapSelectEl.options.length > 0) mapSelectEl.selectedIndex = 0;
}

function createObjWorkerPool(workerCount) {
  const workers = [];
  const pending = new Map();
  let nextWorker = 0;
  let nextReqId = 1;
  for (let i = 0; i < workerCount; i++) {
    const w = new Worker("./obj-worker.js", { type: "module" });
    w.onmessage = (ev) => {
      const msg = ev.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (!msg.ok) {
        p.reject(new Error(msg.error || "worker parse failed"));
        return;
      }
      p.resolve(msg);
    };
    workers.push(w);
  }
  return {
    parse(path) {
      return new Promise((resolve, reject) => {
        const id = nextReqId++;
        pending.set(id, { resolve, reject });
        const w = workers[nextWorker];
        nextWorker = (nextWorker + 1) % workers.length;
        w.postMessage({ id, path });
      });
    },
  };
}

const objWorkerPool = createObjWorkerPool(Math.max(2, Math.min(8, Math.floor((navigator.hardwareConcurrency || 8) / 2))));

async function loadCollisionObj(entryOrPath) {
  const path = typeof entryOrPath === "string" ? entryOrPath : entryOrPath.path;
  const parsed = await objWorkerPool.parse(path);
  const meshData = parsed.meshes && parsed.meshes.length > 0 ? parsed.meshes[0] : null;
  if (!meshData) throw new Error(`empty obj: ${path}`);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(meshData.positions, 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(meshData.indices), 1));
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, makeNavMaterial(COLLISION_BASE_COLOR));
  const g = new THREE.Group();
  g.name = path;
  g.userData.manualEnabled = true;
  g.userData.kind = "collision";
  g.userData.triangleCount = Math.floor((meshData.indices || []).length / 3);
  g.add(mesh);
  if (APPLY_Z_FLIP) g.scale.z = -1;
  return g;
}

async function loadNavObj(entry) {
  const path = entry.path;
  const sourcePath = entry.sourcePath || path;
  const parsed = await objWorkerPool.parse(path);
  const g = new THREE.Group();
  g.name = sourcePath;
  g.userData.manualEnabled = true;
  g.userData.kind = "navmesh";
  g.userData.sourcePath = sourcePath;
  g.userData.loadPath = path;
  const meshes = parsed.meshes || [];
  const mergedPositions = [];
  const mergedIndices = [];
  let mergedVertexOffset = 0;
  meshes.forEach((m, i) => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(m.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(m.indices), 1));
    geom.computeVertexNormals();
    const mesh = new THREE.Mesh(geom, makeNavMaterial(NAV_STATE_COLORS.unset));
    mesh.userData.kind = "nav-segment";
    mesh.userData.segmentIndex = i;
    mesh.userData.parentPath = sourcePath;
    g.add(mesh);

    const localPos = m.positions || [];
    const localIdx = m.indices || [];
    for (let pi = 0; pi < localPos.length; pi++) mergedPositions.push(localPos[pi]);
    for (let ii = 0; ii < localIdx.length; ii++) mergedIndices.push(localIdx[ii] + mergedVertexOffset);
    mergedVertexOffset += Math.floor(localPos.length / 3);
  });
  if (mergedPositions.length > 0 && mergedIndices.length > 0) {
    const mergedGeom = new THREE.BufferGeometry();
    mergedGeom.setAttribute("position", new THREE.Float32BufferAttribute(mergedPositions, 3));
    mergedGeom.setIndex(new THREE.BufferAttribute(new Uint32Array(mergedIndices), 1));
    mergedGeom.computeVertexNormals();
    const mergedMesh = new THREE.Mesh(mergedGeom, makeNavMaterial(NAV_STATE_COLORS.unset));
    mergedMesh.userData.kind = "nav-merged";
    mergedMesh.userData.parentPath = sourcePath;
    mergedMesh.visible = false;
    g.add(mergedMesh);
    g.userData.mergedMesh = mergedMesh;
  }
  g.userData.segmentCount = meshes.length;
  if (APPLY_Z_FLIP) g.scale.z = -1;
  return g;
}

async function loadObjList(entries, loader, onProgress) {
  const group = new THREE.Group();
  const failed = [];
  let done = 0;
  for (const entry of entries) {
    try {
      const g = await loader(entry);
      g.userData.meta = entry;
      group.add(g);
    } catch (_e) {
      failed.push(entry.path);
    } finally {
      done += 1;
      if (onProgress) onProgress(done, entries.length);
    }
  }
  return { group, failed };
}

function collectEnabledPaths(group) {
  if (!group) return [];
  const out = [];
  for (const child of group.children) {
    if (child.userData.manualEnabled !== false) out.push(child.name);
  }
  return out;
}

function collectSelectedNavSegments() {
  const out = [];
  for (const [k, used] of navSegmentUsageStates.entries()) {
    if (!used) continue;
    const split = k.lastIndexOf("::");
    if (split <= 0) continue;
    const nav_name = k.slice(0, split);
    const segment_index = Number(k.slice(split + 2));
    out.push({ nav_name, segment_index });
  }
  return out;
}

function readProfileSelection(profile) {
  const selectedSegments = Array.isArray(profile?.selection?.selected_nav_segments)
    ? profile.selection.selected_nav_segments
    : [];
  navSegmentUsageStates.clear();
  for (const x of selectedSegments) {
    const navName = x?.nav_name;
    if (!navName || typeof navName !== "string") continue;
    navSegmentUsageStates.set(navSegKey(navName, Number(x.segment_index || 0)), true);
  }
}

function applySavedProfile(profile) {
  const collisionEnabledPaths = Array.isArray(profile?.visibility?.collision_enabled_paths)
    ? profile.visibility.collision_enabled_paths
    : [];
  const navEnabledPaths = Array.isArray(profile?.visibility?.navmesh_enabled_paths)
    ? profile.visibility.navmesh_enabled_paths
    : [];

  const cset = new Set(collisionEnabledPaths);
  const nset = new Set(navEnabledPaths);
  const cBase = new Set(Array.from(cset).map((p) => displayName(String(p || ""))));
  const nBase = new Set(Array.from(nset).map((p) => displayName(String(p || ""))));
  if (collisionGroup) {
    let matched = 0;
    for (const child of collisionGroup.children) {
      const on = cset.has(child.name) || cBase.has(displayName(child.name));
      if (on) matched++;
      child.userData.manualEnabled = on;
    }
    if (cset.size > 0 && matched === 0) {
      for (const child of collisionGroup.children) child.userData.manualEnabled = true;
    }
  }
  if (navmeshGroup) {
    let matched = 0;
    for (const child of navmeshGroup.children) {
      const on = nset.has(child.name) || nBase.has(displayName(child.name));
      if (on) matched++;
      child.userData.manualEnabled = on;
    }
    if (nset.size > 0 && matched === 0) {
      for (const child of navmeshGroup.children) child.userData.manualEnabled = true;
    }
  }
  readProfileSelection(profile);
}

function applyStage(stage) {
  const prevStage = currentStage;
  const normalizedStage = stageManager.switchTo(stage, buildStageContext());
  if (!hasAppliedInitialStage && normalizedStage === prevStage) {
    stageManager.get(normalizedStage)?.enter?.(buildStageContext());
  }
  hasAppliedInitialStage = true;
  currentStage = normalizedStage;
  for (const r of stageRadioEls) r.checked = Number(r.value) === normalizedStage;
  clearSelection();
  applyCollisionVisibility();
  collisionSystem.applyOpacity();
  navSystem.applyVisibility(true);
  applyCollisionVisuals();
  applyNavVisuals();
  setStatus(`${getStageConfig().name || `Stage ${normalizedStage}`}`);
}

const stageContext = {
  currentStage,
  collisionGroup,
  navmeshGroup,
  selectedTarget,
  camera,
  controls,
  scene,
  root,
  renderer,
  runtime,
  navSegmentUsageStates,
  requestNavVisualRefresh: applyNavVisuals,
  setStatus,
  systems: {
    collision: collisionSystem,
    nav: navSystem,
    physics: physicsSystem,
    thirdPerson: thirdPersonSystem,
    navProbe: navProbeSystem,
  },
  ui: {
    setSegmentToolsEnabled(enabled) {
      void enabled;
    },
    setCameraModeButton({ visible, text }) {
      if (!cameraModeBtn) return;
      cameraModeBtn.style.display = visible ? "" : "none";
      if (typeof text === "string") cameraModeBtn.textContent = text;
    },
  },
  actions: {
    hideSelectedObject: doHideSelectedObject,
  },
};

function refreshStageContext() {
  stageContext.currentStage = currentStage;
  stageContext.collisionGroup = collisionGroup;
  stageContext.navmeshGroup = navmeshGroup;
  stageContext.selectedTarget = selectedTarget;
  return stageContext;
}

function buildStageContext() {
  return refreshStageContext();
}

function applyDefaultVisibilityRules(defaultHitFilterIds = [8]) {
  if (!collisionGroup || !navmeshGroup) return;
  const defaultSet = new Set((defaultHitFilterIds || []).map((x) => Number(x)));
  const forceHideNavKeys = new Set();

  for (const child of collisionGroup.children) {
    const hf = Number(child.userData?.meta?.msbHitFilterId ?? 255);
    const enabled = defaultSet.has(hf);
    child.userData.manualEnabled = enabled;
    const triCount = Number(child.userData?.triangleCount || 0);
    const isTinyCollisionObj = triCount <= 2;
    if (isTinyCollisionObj) {
      const key = extractBlockKey(child.name);
      if (key) forceHideNavKeys.add(key);
    }
    if (HIDE_NAV_BY_COLLISION_HF.has(hf)) {
      const key = extractBlockKey(child.name);
      if (key) forceHideNavKeys.add(key);
    }
  }

  for (const child of navmeshGroup.children) {
    const key = extractBlockKey(child.name);
    if (!key) {
      child.userData.manualEnabled = true;
      continue;
    }
    child.userData.manualEnabled = !forceHideNavKeys.has(key);
  }
}

function applyCollisionVisibility() {
  collisionSystem.applyVisibility(true);
}

function getHitFilterTypeLabel(hf, sampleObj = null) {
  if (HIT_FILTER_TYPE_LABELS.has(hf)) return HIT_FILTER_TYPE_LABELS.get(hf);
  const fromMeta = String(sampleObj?.userData?.meta?.msbHitFilterType || "").trim();
  if (fromMeta) return fromMeta;
  return "Unknown";
}

function rebuildHitFilterMenu() {
  if (!hitFilterListEl) return;
  hitFilterListEl.innerHTML = "";
  if (!collisionGroup || collisionGroup.children.length === 0) return;
  const groups = new Map();
  for (const child of collisionGroup.children) {
    const hf = Number(child.userData?.meta?.msbHitFilterId ?? 255);
    const key = Number.isFinite(hf) ? hf : 255;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(child);
  }
  for (const [hf, objs] of Array.from(groups.entries()).sort((a, b) => a[0] - b[0])) {
    const total = objs.length;
    const visibleCount = objs.reduce((acc, x) => acc + (x.userData.manualEnabled !== false ? 1 : 0), 0);
    const state = visibleCount === 0 ? "hidden" : (visibleCount === total ? "visible" : "partial");
    const hfTypeLabel = getHitFilterTypeLabel(hf, objs[0]);
    const row = document.createElement("div");
    row.className = "hf-row";
    const text = document.createElement("span");
    text.textContent = `hf:${hf} ${hfTypeLabel} (${total})`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hf-btn";
    btn.title = state === "visible" ? "可见" : (state === "hidden" ? "不可见" : "中间状态");
    btn.innerHTML = state === "visible" ? EYE_VISIBLE_SVG : (state === "hidden" ? EYE_HIDDEN_SVG : EYE_PARTIAL_SVG);
    btn.addEventListener("click", () => {
      const nextVisible = !(visibleCount === total);
      for (const obj of objs) obj.userData.manualEnabled = nextVisible;
      applyCollisionVisibility();
      rebuildObjectMenu();
      rebuildHitFilterMenu();
      applyCollisionVisuals();
    });
    row.appendChild(text);
    row.appendChild(btn);
    hitFilterListEl.appendChild(row);
  }
}

function rebuildObjectMenu() {
  collisionListEl.innerHTML = "";
  navmeshListEl.innerHTML = "";
  rowByKey.clear();

  const createObjRow = ({ key, checked, text, onToggle, onSelect, targetObj }) => {
    const row = document.createElement("label");
    row.className = "obj-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.addEventListener("change", () => onToggle(cb.checked));
    const label = document.createElement("span");
    label.textContent = text;
    row.appendChild(cb);
    row.appendChild(label);
    targetObj.userData.rowKey = key;
    rowByKey.set(key, row);
    row.addEventListener("click", (event) => {
      if (event.target?.tagName?.toLowerCase() === "input") return;
      onSelect();
    });
    return row;
  };

  if (collisionGroup) {
    for (const child of collisionGroup.children) {
      const hf = Number(child.userData?.meta?.msbHitFilterId ?? 255);
      const key = `collision::${child.name}`;
      const row = createObjRow({
        key,
        checked: child.userData.manualEnabled !== false,
        text: `${displayName(child.name)} [hf:${hf}]`,
        onToggle(checked) {
          child.userData.manualEnabled = checked;
          applyCollisionVisibility();
          rebuildHitFilterMenu();
        },
        onSelect() {
          setSelectedTarget(child);
        },
        targetObj: child,
      });
      collisionListEl.appendChild(row);
    }
  }
  if (navmeshGroup) {
    for (const child of navmeshGroup.children) {
      const key = `nav::${child.name}`;
      const row = createObjRow({
        key,
        checked: child.userData.manualEnabled !== false,
        text: `${displayName(child.name)} [split:${child.userData.segmentCount || 0}]`,
        onToggle(checked) {
          child.userData.manualEnabled = checked;
          applyNavVisuals();
        },
        onSelect() {
          const stageCfg = getStageConfig();
          setSelectedTarget(stageCfg.resolveNavMenuSelection(child));
        },
        targetObj: child,
      });
      navmeshListEl.appendChild(row);
    }
  }
}

function getPick(event) {
  const stageCfg = getStageConfig();
  const rect = renderer.domElement.getBoundingClientRect();
  const mouseNdc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  pickRaycaster.setFromCamera(mouseNdc, camera);
  const hits = pickRaycaster.intersectObjects(root.children, true);
  for (const hit of hits) {
    if (!hit.object || hit.object.visible === false) continue;
    let node = hit.object;
    while (node && node.parent !== collisionGroup && node.parent !== navmeshGroup) node = node.parent;
    if (!node || !isObjectHierarchyVisible(node) || !isObjectHierarchyVisible(hit.object)) continue;
    const picked = stageCfg.resolvePick(hit, node);
    if (picked) return picked;
  }
  return null;
}

function isObjectHierarchyVisible(obj) {
  let cur = obj;
  while (cur) {
    if (cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

function doHideSelectedObject() {
  if (!selectedTarget) return;
  if (selectedTarget.userData.kind === "collision" || selectedTarget.userData.kind === "navmesh") {
    selectedTarget.userData.manualEnabled = false;
    applyCollisionVisibility();
    applyNavVisuals();
    clearSelection();
    rebuildObjectMenu();
    rebuildHitFilterMenu();
  }
}

function resetVisibleStatesInMemory() {
  applyDefaultVisibilityRules(currentDefaultHitFilterIds);
  clearSelection();
  applyCollisionVisibility();
  applyNavVisuals();
  rebuildObjectMenu();
  rebuildHitFilterMenu();
  setStatus("visible states reset in memory; click Save Filter to persist", false, 2200);
}

function resetNavSegmentStatesInMemory() {
  navSegmentUsageStates.clear();
  clearSelection();
  applyNavVisuals();
  setStatus("nav segment states reset in memory; click Save Filter to persist", false, 2200);
}

function ensureAnyVisible() {
  const anyCollisionVisible = collisionGroup
    ? collisionGroup.children.some((x) => x.userData.manualEnabled !== false)
    : false;
  const anyNavVisible = navmeshGroup
    ? navmeshGroup.children.some((x) => x.userData.manualEnabled !== false)
    : false;
  if (!anyCollisionVisible && !anyNavVisible) {
    resetVisibleStatesInMemory();
    setStatus("saved profile matched 0 objects, reset to defaults in memory", false, 2600);
  }
}

async function reload() {
  if (isReloading) {
    queuedReload = true;
    return;
  }
  isReloading = true;
  const mapId = mapSelectEl.value;
  if (!mapId) {
    isReloading = false;
    return;
  }
  currentMapId = mapId;
  mapSelectEl.disabled = true;
  setLoadProgress(`loading ${mapId}`, 0);
  setStatus(`loading ${mapId} ...`);
  try {
    navSegmentUsageStates.clear();
    if (collisionGroup) root.remove(collisionGroup);
    if (navmeshGroup) root.remove(navmeshGroup);
    const payload = await fetchJson(`/api/maps/${mapId}/content`);
    currentDefaultHitFilterIds = Array.isArray(payload.default_hit_filter_ids)
      ? payload.default_hit_filter_ids.map((x) => Number(x)).filter((x) => Number.isFinite(x))
      : [8];
    const profileStage = normalizeStage(currentStage);
    const collisionEntries = (payload.collision_manifest.instances || []).map((x) => ({
      path: x.OutObjFile,
      msbHitFilterId: Number.isFinite(x.MsbHitFilterId) ? x.MsbHitFilterId : 255,
      msbHitFilterType: x.MsbHitFilterType || "Unknown",
    }));
    const navmeshEntries = (payload.navmesh_manifest.navmeshes || []).map((x) => ({
      path: x.path,
      sourcePath: x.original_path || x.path,
    }));
    const totalEntries = collisionEntries.length + navmeshEntries.length;
    if (totalEntries === 0) setLoadProgress(`loaded ${mapId}`, 1);
    let loadedEntries = 0;
    const updateProgress = () => {
      if (totalEntries <= 0) return;
      setLoadProgress(`loading ${mapId}`, loadedEntries / totalEntries);
    };
    const [cResult, nResult] = await Promise.all([
      loadObjList(collisionEntries, loadCollisionObj, () => {
        loadedEntries += 1;
        updateProgress();
      }),
      loadObjList(navmeshEntries, loadNavObj, () => {
        loadedEntries += 1;
        updateProgress();
      }),
    ]);
    collisionGroup = cResult.group;
    navmeshGroup = nResult.group;
    collisionSystem.setGroup(collisionGroup);
    navSystem.setGroup(navmeshGroup);
    root.add(collisionGroup);
    root.add(navmeshGroup);
    applyCollisionMaterial(collisionGroup, 0.5);
    if (payload.saved_profile_exists && payload.saved_profile) {
      applySavedProfile(payload.saved_profile);
    } else {
      applyDefaultVisibilityRules(currentDefaultHitFilterIds);
    }
    ensureAnyVisible();
    rebuildObjectMenu();
    rebuildHitFilterMenu();
    applyStage(profileStage);
    getStageConfig().onSceneReload?.(buildStageContext());
    setLoadProgress(`loaded ${mapId}`, 1, false);
    setStatus(`loaded ${mapId}\ncollision: ${collisionGroup.children.length}\nnavmesh: ${navmeshGroup.children.length}\nfailed: ${cResult.failed.length + nResult.failed.length}`);
  } catch (e) {
    setLoadProgress(`load failed ${mapId}`, 0, true);
    setStatus(`load failed: ${e.message || e}`, true);
  } finally {
    mapSelectEl.disabled = false;
    isReloading = false;
    if (queuedReload) {
      queuedReload = false;
      void reload();
    }
  }
}

async function saveProfile() {
  if (!currentMapId) return;
  const collision_enabled_paths = collectEnabledPaths(collisionGroup);
  const navmesh_enabled_paths = collectEnabledPaths(navmeshGroup);
  const selected_nav_segments = collectSelectedNavSegments();
  try {
    const res = await fetch(`/api/maps/${currentMapId}/filter-profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        map_id: currentMapId,
        collision_enabled_paths,
        navmesh_enabled_paths,
        selected_nav_segments,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`saved filter_profile.json for ${currentMapId}`, false, 2200);
  } catch (e) {
    setStatus(`save failed: ${e.message || e}`, true);
  }
}

function registerUiHandlers() {
  for (const r of stageRadioEls) {
    r.addEventListener("change", () => {
      if (r.checked) applyStage(Number(r.value));
    });
  }
  mapSelectEl.addEventListener("change", () => { void reload(); });
  fitBtn.addEventListener("click", () => {
    if (!navmeshGroup && !collisionGroup) return;
    const target = navmeshGroup || collisionGroup;
    const box = new THREE.Box3().setFromObject(target);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.9 + 1;
    camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.7, radius));
    controls.target.copy(center);
  });
  resetVisibleBtn.addEventListener("click", resetVisibleStatesInMemory);
  resetNavSegmentBtn.addEventListener("click", resetNavSegmentStatesInMemory);
  saveBtn.addEventListener("click", saveProfile);
  if (cameraModeBtn) {
    cameraModeBtn.addEventListener("click", () => {
      getStageConfig().handleToggleCameraMode?.(buildStageContext());
    });
  }
}

function registerInputHandlers() {
  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (getStageConfig().onPointerDown?.(buildStageContext(), event)) {
      event.preventDefault();
      return;
    }
    if (event.button === 1) return;
    pointerDown = true;
    pointerDownX = event.clientX;
    pointerDownY = event.clientY;
  });
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (getStageConfig().onPointerMove?.(buildStageContext(), event)) {
      event.preventDefault();
    }
    if (!pointerDown) return;
    const dx = event.clientX - pointerDownX;
    const dy = event.clientY - pointerDownY;
    if (dx * dx + dy * dy > 16) suppressNextClick = true;
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    if (getStageConfig().onPointerUp?.(buildStageContext(), event)) {
      event.preventDefault();
    }
    pointerDown = false;
  });
  renderer.domElement.addEventListener("click", (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (getStageConfig().onPointerClick?.(buildStageContext(), event)) return;
    const picked = getPick(event);
    setSelectedTarget(picked);
  });
  window.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    const tag = active?.tagName?.toLowerCase() || "";
    const inputType = active && tag === "input" ? String(active.type || "").toLowerCase() : "";
    const isTextLikeInput =
      tag === "textarea" ||
      tag === "select" ||
      (tag === "input" && (
        inputType === "text" ||
        inputType === "number" ||
        inputType === "search" ||
        inputType === "email" ||
        inputType === "url" ||
        inputType === "tel" ||
        inputType === "password"
      ));
    if (isTextLikeInput) return;
    if (getStageConfig().onKeyDown?.(buildStageContext(), event)) {
      event.preventDefault();
    }
  });
  window.addEventListener("keyup", (event) => {
    getStageConfig().onKeyUp?.(buildStageContext(), event);
  });
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    csm.updateFrustums();
  });
}

registerUiHandlers();
registerInputHandlers();

function animate() {
  const dt = clock.getDelta();
  stageManager.update(buildStageContext(), dt);
  controls.update();
  csm.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
updateStageLabels();
await loadMapList();
await reload();
