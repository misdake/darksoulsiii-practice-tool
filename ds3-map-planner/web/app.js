import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSM } from "three/addons/csm/CSM.js";

const app = document.getElementById("app");
const mapSelectEl = document.getElementById("mapSelect");
const showCollisionEl = document.getElementById("showCollision");
const collisionOpacityEl = document.getElementById("collisionOpacity");
const collisionOpacityValueEl = document.getElementById("collisionOpacityValue");
const showNavmeshEl = document.getElementById("showNavmesh");
const loadBtn = document.getElementById("loadBtn");
const fitBtn = document.getElementById("fitBtn");
const resetDefaultBtn = document.getElementById("resetDefaultBtn");
const triCullModeBtn = document.getElementById("triCullModeBtn");
const saveBtn = document.getElementById("saveBtn");
const collisionListEl = document.getElementById("collisionList");
const navmeshListEl = document.getElementById("navmeshList");
const statusEl = document.getElementById("status");
const boxSelectOverlay = document.getElementById("boxSelectOverlay");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1115);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 2000);
camera.position.set(100, 80, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 0.5);
dir.position.set(120, 220, 100);
scene.add(dir);

const root = new THREE.Group();
scene.add(root);

const csm = new CSM({
  camera,
  parent: scene,
  cascades: 4,
  maxFar: 1500,
  mode: "practical",
  shadowMapSize: 2048,
  lightDirection: new THREE.Vector3(-0.6, -1.0, -0.45).normalize(),
  lightIntensity: 1.0,
  lightNear: 1,
  lightFar: 1800,
  fade: true,
});

const APPLY_Z_FLIP = true;
const COLLISION_BASE_COLOR = 0x94a3b8;
const NAVMESH_BASE_COLOR = 0xff8a3d;
const COLLISION_HIGHLIGHT_COLOR = 0xc7d2e2;
const NAVMESH_HIGHLIGHT_COLOR = 0xffbe8a;
const CULLED_PREVIEW_COLOR = 0x29b6f6;
const RESET_FORCE_HIDE_NAV_BY_COLLISION_HF = new Set([13, 14, 15]);

const objWorkerPool = createObjWorkerPool(Math.max(2, Math.min(8, Math.floor((navigator.hardwareConcurrency || 8) / 2))));
const raycaster = new THREE.Raycaster();
const mouseNdc = new THREE.Vector2();

let currentMapId = "";
let collisionGroup = null;
let navmeshGroup = null;
let selectedTarget = null;
let pointerDown = false;
let pointerDownX = 0;
let pointerDownY = 0;
let suppressNextClick = false;
let statusResetTimer = null;
const rowByPath = new Map();
let triangleCullMode = false;
const culledTrianglesByPath = new Map();
let middleDown = false;
let middleDrag = false;
let middleStartX = 0;
let middleStartY = 0;
let middleLastX = 0;
let middleLastY = 0;

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

function applyMaterial(group, color, options = {}) {
  const opacity = Number(options.opacity ?? 1);
  const forceTransparent = options.forceTransparent === true;
  const transparent = forceTransparent || opacity < 1;
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.7,
      metalness: 0.0,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      transparent,
      opacity,
      depthWrite: !transparent,
    });
    obj.castShadow = true;
    obj.receiveShadow = true;
    csm.setupMaterial(obj.material);
  });
}

function setGroupColor(target, color) {
  if (!target) return;
  target.traverse((obj) => {
    if (obj.userData && obj.userData.isCulledPreview) return;
    if (!obj.isMesh || !obj.material || !obj.material.color) return;
    obj.material.color.setHex(color);
  });
}

function updateTriCullModeUi() {
  triCullModeBtn.textContent = triangleCullMode ? "Triangle Cull: On" : "Triangle Cull: Off";
}

function setSelectedTarget(target) {
  if (selectedTarget === target) return;
  if (selectedTarget) {
    const baseColor = selectedTarget.userData.kind === "navmesh" ? NAVMESH_BASE_COLOR : COLLISION_BASE_COLOR;
    setGroupColor(selectedTarget, baseColor);
  }
  selectedTarget = target;
  highlightSelectedRow(target);
  if (selectedTarget) {
    const hi = selectedTarget.userData.kind === "navmesh" ? NAVMESH_HIGHLIGHT_COLOR : COLLISION_HIGHLIGHT_COLOR;
    setGroupColor(selectedTarget, hi);
    setStatus(`picked: ${displayName(selectedTarget.name)}`);
  }
}

function highlightSelectedRow(target) {
  for (const row of rowByPath.values()) {
    row.classList.remove("obj-item-selected");
  }
  if (!target) return;
  const row = rowByPath.get(target.name);
  if (!row) return;
  row.classList.add("obj-item-selected");
  row.scrollIntoView({ block: "nearest" });
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.json();
}

async function loadMapList() {
  const data = await fetchJson("/api/maps");
  mapSelectEl.innerHTML = "";
  for (const item of data.maps || []) {
    const mapId = typeof item === "string" ? item : item.map_id;
    const displayName = typeof item === "string" ? item : (item.display_name || item.map_id);
    if (!mapId) continue;
    const opt = document.createElement("option");
    opt.value = mapId;
    opt.textContent = `${mapId} - ${displayName}`;
    mapSelectEl.appendChild(opt);
  }
  if (!mapSelectEl.value && mapSelectEl.options.length > 0) {
    mapSelectEl.selectedIndex = 0;
  }
}

async function loadObj(path) {
  const parsed = await objWorkerPool.parse(path);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
  if (parsed.indices && parsed.indices.length > 0) {
    geom.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
  }
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  const group = new THREE.Group();
  group.add(mesh);
  const indexArray = geom.index ? geom.index.array : null;
  group.userData.originalIndices = indexArray ? new Uint32Array(indexArray) : null;
  group.userData.culledTriangles = new Set();
  group.userData.adjBuilt = false;
  group.userData.triAdj = null;
  group.userData.triangleCount = parsed.indices && parsed.indices.length > 0
    ? Math.floor(parsed.indices.length / 3)
    : Math.floor(parsed.positions.length / 9);
  group.userData.downloadBytes = Number(parsed.downloadBytes || 0);
  if (APPLY_Z_FLIP) group.scale.z = -1;
  return group;
}

async function loadObjList(entries, onProgress) {
  const group = new THREE.Group();
  const failed = [];
  let done = 0;
  let bytesDone = 0;
  const bytesTotal = entries.reduce((acc, e) => acc + Number(e.objSizeBytes || 0), 0);
  for (const entry of entries) {
    try {
      const g = await loadObj(entry.path);
      g.name = entry.path;
      g.userData.meta = entry;
      group.add(g);
      bytesDone += Number(g.userData.downloadBytes || entry.objSizeBytes || 0);
    } catch (e) {
      failed.push(entry.path);
      bytesDone += Number(entry.objSizeBytes || 0);
    } finally {
      done += 1;
      if (onProgress) onProgress(done, entries.length, bytesDone, bytesTotal);
    }
  }
  return { group, failed };
}

function formatBytesMiB(bytes) {
  const mib = Number(bytes || 0) / (1024 * 1024);
  return `${mib.toFixed(1)} MB`;
}

function rebuildObjectMenu() {
  collisionListEl.innerHTML = "";
  navmeshListEl.innerHTML = "";
  rowByPath.clear();

  if (collisionGroup) {
    for (const child of collisionGroup.children) {
      const row = document.createElement("label");
      row.className = "obj-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = child.userData.manualEnabled !== false;
      cb.addEventListener("change", () => {
        child.userData.manualEnabled = cb.checked;
        applyCollisionVisibility();
      });
      const meta = child.userData.meta || {};
      const text = document.createElement("span");
      text.textContent = `${displayName(child.name)} [hf:${meta.msbHitFilterId}]`;
      row.appendChild(cb);
      row.appendChild(text);
      rowByPath.set(child.name, row);
      row.addEventListener("click", (event) => {
        if (event.target && event.target.tagName && event.target.tagName.toLowerCase() === "input") return;
        setSelectedTarget(child);
        focusCameraToObject(child);
      });
      collisionListEl.appendChild(row);
    }
  }

  if (navmeshGroup) {
    for (const child of navmeshGroup.children) {
      const row = document.createElement("label");
      row.className = "obj-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = child.userData.manualEnabled !== false;
      cb.addEventListener("change", () => {
        child.userData.manualEnabled = cb.checked;
        child.visible = showNavmeshEl.checked && cb.checked;
      });
      const text = document.createElement("span");
      text.textContent = displayName(child.name);
      row.appendChild(cb);
      row.appendChild(text);
      rowByPath.set(child.name, row);
      row.addEventListener("click", (event) => {
        if (event.target && event.target.tagName && event.target.tagName.toLowerCase() === "input") return;
        setSelectedTarget(child);
        focusCameraToObject(child);
      });
      navmeshListEl.appendChild(row);
    }
  }
  highlightSelectedRow(selectedTarget);
}

function applyCollisionVisibility() {
  if (!collisionGroup) return;
  for (const child of collisionGroup.children) {
    child.visible = child.userData.manualEnabled !== false;
  }
  if (selectedTarget && selectedTarget.userData.kind === "collision" && !selectedTarget.visible) {
    setSelectedTarget(null);
  }
}

function applyCollisionOpacity() {
  if (!collisionOpacityEl || !collisionOpacityValueEl) return;
  const opacity = Number(collisionOpacityEl.value);
  collisionOpacityValueEl.textContent = opacity.toFixed(2);
  if (!collisionGroup) return;
  collisionGroup.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const applyOne = (mat) => {
      if (!mat) return;
      mat.transparent = true;
      mat.opacity = opacity;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    };
    if (Array.isArray(obj.material)) {
      for (const mat of obj.material) applyOne(mat);
    } else {
      applyOne(obj.material);
    }
  });
}

function ensureTriangleAdjacency(target) {
  if (!target || target.userData.adjBuilt) return;
  const mesh = target.children && target.children[0] && target.children[0].isMesh ? target.children[0] : null;
  if (!mesh || !mesh.geometry || !mesh.geometry.index) {
    target.userData.adjBuilt = true;
    target.userData.triAdj = [];
    return;
  }
  const idx = mesh.geometry.index.array;
  const pos = mesh.geometry.attributes.position;
  const triCount = Math.floor(idx.length / 3);
  const coordToTri = new Map();
  const coordKey = (vi) => {
    const x = pos.getX(vi).toFixed(6);
    const y = pos.getY(vi).toFixed(6);
    const z = pos.getZ(vi).toFixed(6);
    return `${x},${y},${z}`;
  };
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3 + 0], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    for (const v of [a, b, c]) {
      const k = coordKey(v);
      let arr = coordToTri.get(k);
      if (!arr) {
        arr = [];
        coordToTri.set(k, arr);
      }
      arr.push(t);
    }
  }
  const adj = Array.from({ length: triCount }, () => new Set());
  for (const tris of coordToTri.values()) {
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        const t1 = tris[i], t2 = tris[j];
        adj[t1].add(t2);
        adj[t2].add(t1);
      }
    }
  }
  target.userData.triAdj = adj.map((x) => Array.from(x));
  target.userData.adjBuilt = true;
}

function applyCulledTrianglesToGeometry(target) {
  if (!target) return;
  const mesh = target.children && target.children[0] && target.children[0].isMesh ? target.children[0] : null;
  if (!mesh || !mesh.geometry || !mesh.geometry.index || !target.userData.originalIndices) return;
  const next = new Uint32Array(target.userData.originalIndices);
  const culled = target.userData.culledTriangles || new Set();
  for (const tri of culled) {
    const base = tri * 3;
    if (base + 2 >= next.length) continue;
    const v = next[base];
    next[base] = v;
    next[base + 1] = v;
    next[base + 2] = v;
  }
  mesh.geometry.setIndex(new THREE.BufferAttribute(next, 1));
  mesh.geometry.computeVertexNormals();
  rebuildCulledPreviewMesh(target);
}

function rebuildCulledPreviewMesh(target) {
  const old = target.children.find((c) => c.userData && c.userData.isCulledPreview);
  if (old) {
    target.remove(old);
    if (old.geometry) old.geometry.dispose();
    if (old.material) old.material.dispose();
  }
  const culled = target.userData.culledTriangles || new Set();
  if (culled.size === 0) return;
  const mesh = target.children && target.children[0] && target.children[0].isMesh ? target.children[0] : null;
  if (!mesh || !mesh.geometry || !mesh.geometry.index || !target.userData.originalIndices) return;
  const pos = mesh.geometry.attributes.position;
  const orig = target.userData.originalIndices;
  const outPos = [];
  for (const tri of culled) {
    const base = tri * 3;
    if (base + 2 >= orig.length) continue;
    const ia = orig[base + 0], ib = orig[base + 1], ic = orig[base + 2];
    outPos.push(pos.getX(ia), pos.getY(ia), pos.getZ(ia));
    outPos.push(pos.getX(ib), pos.getY(ib), pos.getZ(ib));
    outPos.push(pos.getX(ic), pos.getY(ic), pos.getZ(ic));
  }
  if (outPos.length === 0) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(outPos, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({
    color: CULLED_PREVIEW_COLOR,
    emissive: new THREE.Color(0x0e3c55),
    roughness: 0.4,
    metalness: 0.0,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  const preview = new THREE.Mesh(g, m);
  preview.userData.isCulledPreview = true;
  preview.castShadow = false;
  preview.receiveShadow = false;
  target.add(preview);
}

function cullConnectedTriangles(target, seedTriangle) {
  ensureTriangleAdjacency(target);
  const adj = target.userData.triAdj || [];
  if (seedTriangle < 0 || seedTriangle >= adj.length) return 0;
  const seen = new Set();
  const stack = [seedTriangle];
  const culled = target.userData.culledTriangles || new Set();
  while (stack.length > 0) {
    const t = stack.pop();
    if (seen.has(t)) continue;
    seen.add(t);
    if (culled.has(t)) continue;
    culled.add(t);
    for (const n of (adj[t] || [])) {
      if (!seen.has(n)) stack.push(n);
    }
  }
  target.userData.culledTriangles = culled;
  culledTrianglesByPath.set(target.name, culled);
  applyCulledTrianglesToGeometry(target);
  return seen.size;
}

function cullTrianglesByScreenBox(x0, y0, x1, y1) {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const all = navmeshGroup ? navmeshGroup.children : [];
  let triTotal = 0;
  let objTouched = 0;

  for (const g of all) {
    if (!isObjectHierarchyVisible(g)) continue;
    const mesh = g.children && g.children[0] && g.children[0].isMesh ? g.children[0] : null;
    if (!mesh || !mesh.geometry || !mesh.geometry.index) continue;
    const pos = mesh.geometry.attributes.position;
    const idx = mesh.geometry.index.array;
    const triCount = Math.floor(idx.length / 3);
    let touched = false;
    for (let t = 0; t < triCount; t++) {
      const ia = idx[t * 3 + 0], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2];
      const va = new THREE.Vector3(pos.getX(ia), pos.getY(ia), pos.getZ(ia)).applyMatrix4(mesh.matrixWorld);
      const vb = new THREE.Vector3(pos.getX(ib), pos.getY(ib), pos.getZ(ib)).applyMatrix4(mesh.matrixWorld);
      const vc = new THREE.Vector3(pos.getX(ic), pos.getY(ic), pos.getZ(ic)).applyMatrix4(mesh.matrixWorld);
      const cen = new THREE.Vector3().add(va).add(vb).add(vc).multiplyScalar(1 / 3).project(camera);
      if (cen.z < -1 || cen.z > 1) continue;
      const sx = (cen.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-cen.y * 0.5 + 0.5) * window.innerHeight;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        const culled = g.userData.culledTriangles || new Set();
        if (!culled.has(t)) {
          culled.add(t);
          g.userData.culledTriangles = culled;
          culledTrianglesByPath.set(g.name, culled);
          triTotal++;
          touched = true;
        }
      }
    }
    if (touched) {
      applyCulledTrianglesToGeometry(g);
      objTouched++;
    }
  }
  return { triTotal, objTouched };
}

function rangesFromSet(s) {
  const arr = Array.from(s).sort((a, b) => a - b);
  if (arr.length === 0) return [];
  const out = [];
  let start = arr[0];
  let prev = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i];
    if (v === prev + 1) {
      prev = v;
      continue;
    }
    out.push([start, prev]);
    start = v;
    prev = v;
  }
  out.push([start, prev]);
  return out;
}

function applySavedTriangleCull(profile) {
  const entries = (profile && profile.culled_triangles) ? profile.culled_triangles : [];
  const all = navmeshGroup ? navmeshGroup.children : [];
  for (const e of entries) {
    if (e.kind && e.kind !== "navmesh") continue;
    const target = all.find((x) => x.name === e.path);
    if (!target) continue;
    const set = new Set();
    for (const r of (e.ranges || [])) {
      const start = Number(r[0]);
      const end = Number(r[1]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      for (let t = start; t <= end; t++) set.add(t);
    }
    target.userData.culledTriangles = set;
    culledTrianglesByPath.set(target.name, set);
    applyCulledTrianglesToGeometry(target);
  }
}

function fitCamera() {
  const box = new THREE.Box3();
  let hasVisible = false;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.visible) return;
    let cur = obj.parent;
    while (cur) {
      if (cur.visible === false) return;
      cur = cur.parent;
    }
    obj.geometry.computeBoundingBox();
    if (!obj.geometry.boundingBox) return;
    const meshBox = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
    box.union(meshBox);
    hasVisible = true;
  });
  if (!hasVisible || box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.7 + 1;
  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.8, radius));
  controls.target.copy(center);
}

function applySavedProfile(profile) {
  if (!profile) return;
  const cset = new Set(profile.collision_enabled_paths || []);
  const nset = new Set(profile.navmesh_enabled_paths || []);
  if (collisionGroup) {
    for (const child of collisionGroup.children) {
      child.userData.manualEnabled = cset.has(child.name);
    }
  }
  if (navmeshGroup) {
    for (const child of navmeshGroup.children) {
      child.userData.manualEnabled = nset.has(child.name);
      child.visible = child.userData.manualEnabled;
    }
  }
}

function applyDefaultVisibilityRules() {
  if (!collisionGroup || !navmeshGroup) return;
  const forceHideNavKeys = new Set();
  for (const child of collisionGroup.children) {
    child.userData.manualEnabled = true;
    child.visible = true;
  }
  for (const child of navmeshGroup.children) {
    child.userData.manualEnabled = true;
    child.visible = true;
  }
  for (const child of collisionGroup.children) {
    const meta = child.userData.meta || {};
    const hf = Number(meta.msbHitFilterId);
    const tinyObj = Number(child.userData.triangleCount || 0) <= 2;
    child.userData.manualEnabled = hf === 8 && !tinyObj;
    if (tinyObj) {
      const key = extractBlockKey(child.name);
      if (key) forceHideNavKeys.add(key);
    }
    if (RESET_FORCE_HIDE_NAV_BY_COLLISION_HF.has(hf)) {
      const key = extractBlockKey(child.name);
      if (key) forceHideNavKeys.add(key);
    }
  }
  applyCollisionVisibility();
  for (const child of navmeshGroup.children) {
    const key = extractBlockKey(child.name);
    const tinyObj = Number(child.userData.triangleCount || 0) <= 2;
    if (tinyObj) {
      child.userData.manualEnabled = false;
      child.visible = false;
      continue;
    }
    if (!key) continue;
    let visible = !forceHideNavKeys.has(key);
    child.userData.manualEnabled = visible;
    child.visible = visible;
  }
  setSelectedTarget(null);
  rebuildObjectMenu();
}

function extractBlockKey(path) {
  const name = displayName(path || "");
  const m = name.match(/^[hn](\d{2}_\d{2}_\d{2}_\d{2}_\d{6})(?:__.*|\.obj)$/i);
  if (m) return m[1];
  return "";
}

function pickByMouseEvent(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseNdc, camera);
  const hits = raycaster.intersectObjects(root.children, true);

  for (const hit of hits) {
    if (hit.object && hit.object.userData && hit.object.userData.isCulledPreview) continue;
    let node = hit.object;
    while (node && node.parent !== collisionGroup && node.parent !== navmeshGroup) {
      node = node.parent;
    }
    if (!node) continue;
    if (!isObjectHierarchyVisible(node)) continue;
    setSelectedTarget(node);
    return;
  }

  setSelectedTarget(null);
}

function focusCameraToObject(target) {
  if (!target) return;
  const box = new THREE.Box3().setFromObject(target);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.9 + 1;
  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.7, radius));
  controls.target.copy(center);
}

function isObjectHierarchyVisible(obj) {
  let cur = obj;
  while (cur) {
    if (cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

async function reload() {
  const mapId = mapSelectEl.value;
  if (!mapId) {
    setStatus("no map available", true);
    return;
  }
  currentMapId = mapId;
  setStatus(`loading ${mapId} ...`);
  loadBtn.disabled = true;
  try {
    if (collisionGroup) root.remove(collisionGroup);
    if (navmeshGroup) root.remove(navmeshGroup);
    culledTrianglesByPath.clear();

    const payload = await fetchJson(`/api/maps/${mapId}/content`);
    const collisionEntries = (payload.collision_manifest.instances || []).map((x) => ({
      path: x.OutObjFile,
      msbHitFilterId: Number.isFinite(x.MsbHitFilterId) ? x.MsbHitFilterId : 255,
      msbHitFilterType: x.MsbHitFilterType || "Unknown",
      objSizeBytes: Number(x.OutObjSizeBytes || 0),
    }));
    const navmeshEntries = (payload.navmesh_manifest.navmeshes || []).map((x) => ({
      ...x,
      objSizeBytes: Number(x.obj_size_bytes || x.ObjSizeBytes || 0),
    }));

    let cDone = 0;
    let nDone = 0;
    let cBytesDone = 0;
    let nBytesDone = 0;
    const cTotal = collisionEntries.length;
    const nTotal = navmeshEntries.length;
    const cBytesTotal = collisionEntries.reduce((acc, x) => acc + Number(x.objSizeBytes || 0), 0);
    const nBytesTotal = navmeshEntries.reduce((acc, x) => acc + Number(x.objSizeBytes || 0), 0);
    const updateLoadProgress = () => {
      setStatus(
        `loading ${mapId} ...\n` +
        `collision: ${cDone}/${cTotal} (${formatBytesMiB(cBytesDone)}/${formatBytesMiB(cBytesTotal)})\n` +
        `navmesh: ${nDone}/${nTotal} (${formatBytesMiB(nBytesDone)}/${formatBytesMiB(nBytesTotal)})`
      );
    };
    updateLoadProgress();
    const [cResult, nResult] = await Promise.all([
      loadObjList(collisionEntries, (done, _total, bytesDone) => {
        cDone = done;
        cBytesDone = bytesDone;
        updateLoadProgress();
      }),
      loadObjList(navmeshEntries, (done, _total, bytesDone) => {
        nDone = done;
        nBytesDone = bytesDone;
        updateLoadProgress();
      }),
    ]);
    collisionGroup = cResult.group;
    navmeshGroup = nResult.group;

    for (const child of collisionGroup.children) child.userData.kind = "collision";
    for (const child of navmeshGroup.children) child.userData.kind = "navmesh";

    root.add(collisionGroup);
    root.add(navmeshGroup);
    collisionGroup.visible = showCollisionEl.checked;
    navmeshGroup.visible = showNavmeshEl.checked;
    applyMaterial(collisionGroup, COLLISION_BASE_COLOR, {
      opacity: collisionOpacityEl ? Number(collisionOpacityEl.value) : 0.7,
      forceTransparent: true,
    });
    applyMaterial(navmeshGroup, NAVMESH_BASE_COLOR);
    applyCollisionOpacity();

    for (const child of collisionGroup.children) child.userData.manualEnabled = true;
    for (const child of navmeshGroup.children) {
      child.userData.manualEnabled = true;
      child.visible = true;
    }

    if (payload.saved_profile_exists && payload.saved_profile) {
      applySavedProfile(payload.saved_profile);
      applySavedTriangleCull(payload.saved_profile);
    } else {
      applyDefaultVisibilityRules();
    }
    setSelectedTarget(null);
    applyCollisionVisibility();
    rebuildObjectMenu();
    fitCamera();
    requestAnimationFrame(() => fitCamera());

    const failCount = cResult.failed.length + nResult.failed.length;
    setStatus(`loaded ${mapId}\ncollision: ${collisionGroup.children.length}/${collisionEntries.length}\nnavmesh: ${navmeshGroup.children.length}/${navmeshEntries.length}\nfailed: ${failCount}`);
  } catch (e) {
    setStatus(`load failed: ${e.message || e}`, true);
  } finally {
    loadBtn.disabled = false;
  }
}

async function saveProfile() {
  if (!currentMapId) return;
  const collision_enabled_paths = [];
  const navmesh_enabled_paths = [];
  const culled_triangles = [];

  if (collisionGroup) {
    for (const child of collisionGroup.children) {
      if (child.userData.manualEnabled !== false) collision_enabled_paths.push(child.name);
    }
  }

  if (navmeshGroup) {
    for (const child of navmeshGroup.children) {
      if (child.userData.manualEnabled !== false) {
        navmesh_enabled_paths.push(child.name);
      }
    }
  }
  const all = navmeshGroup ? navmeshGroup.children : [];
  for (const g of all) {
    if (g.userData.kind !== "navmesh") continue;
    const s = g.userData.culledTriangles || new Set();
    if (s.size === 0) continue;
    culled_triangles.push({
      kind: g.userData.kind || "unknown",
      path: g.name,
      ranges: rangesFromSet(s),
    });
  }

  try {
    const res = await fetch(`/api/maps/${currentMapId}/filter-profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collision_enabled_paths, navmesh_enabled_paths, culled_triangles }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`saved filter_profile.json for ${currentMapId}`, false, 2200);
  } catch (e) {
    setStatus(`save failed: ${e.message || e}`, true);
  }
}

function hideSelectedAndSave() {
  if (!selectedTarget) return;
  const target = selectedTarget;
  const name = displayName(target.name);
  target.userData.manualEnabled = false;
  if (target.userData.kind === "collision") {
    applyCollisionVisibility();
  } else {
    target.visible = false;
  }
  setSelectedTarget(null);
  rebuildObjectMenu();
  setStatus(`hidden: ${name}`);
  void saveProfile();
}

function displayName(path) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
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
      p.resolve({
        positions: new Float32Array(msg.positions),
        indices: msg.indices ? new Uint32Array(msg.indices) : null,
        downloadBytes: Number(msg.downloadBytes || 0),
      });
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

showCollisionEl.addEventListener("change", () => applyCollisionVisibility());
if (collisionOpacityEl) {
  collisionOpacityEl.addEventListener("input", () => applyCollisionOpacity());
  collisionOpacityEl.addEventListener("change", () => applyCollisionOpacity());
}
showNavmeshEl.addEventListener("change", () => {
  if (!navmeshGroup) return;
  navmeshGroup.visible = showNavmeshEl.checked;
  if (selectedTarget && selectedTarget.userData.kind === "navmesh" && !navmeshGroup.visible) {
    setSelectedTarget(null);
  }
});
showCollisionEl.addEventListener("change", () => {
  if (!collisionGroup) return;
  collisionGroup.visible = showCollisionEl.checked;
  if (selectedTarget && selectedTarget.userData.kind === "collision" && !collisionGroup.visible) {
    setSelectedTarget(null);
  }
});
applyCollisionOpacity();
loadBtn.addEventListener("click", reload);
fitBtn.addEventListener("click", fitCamera);
resetDefaultBtn.addEventListener("click", () => {
  applyDefaultVisibilityRules();
  setStatus("applied default filter");
});
triCullModeBtn.addEventListener("click", () => {
  triangleCullMode = !triangleCullMode;
  updateTriCullModeUi();
  setStatus(triangleCullMode ? "triangle cull mode on" : "triangle cull mode off", false, 1600);
});
saveBtn.addEventListener("click", saveProfile);

renderer.domElement.addEventListener("pointerdown", (event) => {
  if (event.button === 1 && triangleCullMode) {
    controls.enabled = false;
    middleDown = true;
    middleDrag = false;
    middleStartX = event.clientX;
    middleStartY = event.clientY;
    middleLastX = event.clientX;
    middleLastY = event.clientY;
    boxSelectOverlay.style.display = "block";
    boxSelectOverlay.style.left = `${middleStartX}px`;
    boxSelectOverlay.style.top = `${middleStartY}px`;
    boxSelectOverlay.style.width = "0px";
    boxSelectOverlay.style.height = "0px";
    event.preventDefault();
    return;
  }
  pointerDown = true;
  pointerDownX = event.clientX;
  pointerDownY = event.clientY;
});
renderer.domElement.addEventListener("pointermove", (event) => {
  if (middleDown) {
    middleLastX = event.clientX;
    middleLastY = event.clientY;
    const dx = event.clientX - middleStartX;
    const dy = event.clientY - middleStartY;
    if (dx * dx + dy * dy > 16) middleDrag = true;
    const left = Math.min(middleStartX, event.clientX);
    const top = Math.min(middleStartY, event.clientY);
    const width = Math.abs(event.clientX - middleStartX);
    const height = Math.abs(event.clientY - middleStartY);
    boxSelectOverlay.style.left = `${left}px`;
    boxSelectOverlay.style.top = `${top}px`;
    boxSelectOverlay.style.width = `${width}px`;
    boxSelectOverlay.style.height = `${height}px`;
    return;
  }
  if (!pointerDown) return;
  const dx = event.clientX - pointerDownX;
  const dy = event.clientY - pointerDownY;
  if (dx * dx + dy * dy > 16) suppressNextClick = true;
});
renderer.domElement.addEventListener("pointerup", (event) => {
  if (middleDown) {
    if (triangleCullMode) {
      if (middleDrag) {
        const res = cullTrianglesByScreenBox(middleStartX, middleStartY, middleLastX, middleLastY);
        rebuildObjectMenu();
        setStatus(`box culled tris: ${res.triTotal}, objects: ${res.objTouched}`, false, 2200);
      } else {
        const rect = renderer.domElement.getBoundingClientRect();
        mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouseNdc, camera);
        const hits = raycaster.intersectObjects(root.children, true);
        let handled = false;
        for (const hit of hits) {
          if (!hit.object || !hit.object.isMesh || hit.object.userData?.isCulledPreview || !Number.isFinite(hit.faceIndex)) continue;
          let node = hit.object;
          while (node && node.parent !== collisionGroup && node.parent !== navmeshGroup) node = node.parent;
          if (!node || !isObjectHierarchyVisible(node) || node.userData.kind !== "navmesh") continue;
          const affected = cullConnectedTriangles(node, Math.floor(hit.faceIndex));
          rebuildObjectMenu();
          setStatus(`culled connected tris: ${affected} on ${displayName(node.name)}`, false, 2200);
          handled = true;
          break;
        }
        if (!handled) {
          setStatus("no visible navmesh triangle hit", false, 1400);
        }
      }
    }
    middleDown = false;
    middleDrag = false;
    controls.enabled = true;
    boxSelectOverlay.style.display = "none";
    return;
  }
  pointerDown = false;
});
renderer.domElement.addEventListener("pointercancel", () => {
  middleDown = false;
  controls.enabled = true;
  boxSelectOverlay.style.display = "none";
  pointerDown = false;
});
renderer.domElement.addEventListener("mousedown", (event) => {
  if (!triangleCullMode || event.button !== 1) return;
  event.preventDefault();
});
renderer.domElement.addEventListener("click", (event) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  if (triangleCullMode) return;
  pickByMouseEvent(event);
});
renderer.domElement.addEventListener("dblclick", (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseNdc, camera);
  const hits = raycaster.intersectObjects(root.children, true);
  for (const hit of hits) {
    if (hit.object && hit.object.userData && hit.object.userData.isCulledPreview) continue;
    let node = hit.object;
    while (node && node.parent !== collisionGroup && node.parent !== navmeshGroup) {
      node = node.parent;
    }
    if (!node) continue;
    if (!isObjectHierarchyVisible(node)) continue;
    setSelectedTarget(node);
    focusCameraToObject(node);
    return;
  }
});

window.addEventListener("keydown", (event) => {
  const tag = document.activeElement && document.activeElement.tagName ? document.activeElement.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (event.code === "Space" || event.code === "Delete") {
    event.preventDefault();
    hideSelectedAndSave();
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  csm.updateFrustums();
});

function animate() {
  controls.update();
  csm.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
updateTriCullModeUi();
await loadMapList();
await reload();
