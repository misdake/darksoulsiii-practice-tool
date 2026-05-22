import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const app = document.getElementById("app");
const importListPathEl = document.getElementById("importListPath");
const showCollisionEl = document.getElementById("showCollision");
const showWalkableEl = document.getElementById("showWalkable");
const wireframeEl = document.getElementById("wireframe");
const loadBtn = document.getElementById("loadBtn");
const fitBtn = document.getElementById("fitBtn");
const exportEnabledBtn = document.getElementById("exportEnabledBtn");
const statusEl = document.getElementById("status");
const objectListEl = document.getElementById("objectList");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.getContext().disable(renderer.getContext().CULL_FACE);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1115);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 10000);
camera.position.set(100, 80, 100);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(100, 180, 80);
scene.add(dir);

const grid = new THREE.GridHelper(600, 60, 0x2a3342, 0x1f2733);
grid.position.y = -70;
scene.add(grid);

const root = new THREE.Group();
scene.add(root);

const raycaster = new THREE.Raycaster();
const mouseNdc = new THREE.Vector2();
const APPLY_Z_FLIP = true;
const LOAD_CONCURRENCY = 8;
const WORKER_COUNT = Math.max(2, Math.min(8, Math.floor((navigator.hardwareConcurrency || 8) / 2)));
let collisionGroup = null;
let walkableGroup = null;
let selectedMesh = null;
let selectedMeshEmissive = null;
let lastHitPoint = null;
const meshRowMap = new Map();
const objectById = new Map();
const objWorkerPool = createObjWorkerPool(WORKER_COUNT);

function setStatus(msg, isError = false) {
  statusEl.style.color = isError ? "#ff9f9f" : "#87f5b1";
  const hitText = lastHitPoint
    ? `\nhit: x=${lastHitPoint.x.toFixed(3)}, y=${lastHitPoint.y.toFixed(3)}, z=${lastHitPoint.z.toFixed(3)}`
    : "";
  statusEl.textContent = `${msg}${hitText}`;
}

function applyMaterial(group, color, opacity, wireframe) {
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.9,
      metalness: 0.0,
      transparent: false,
      opacity: 1.0,
      wireframe,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
    });
  });
}

async function loadObjList(paths) {
  const listRoot = new THREE.Group();
  const failed = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(LOAD_CONCURRENCY, paths.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= paths.length) break;
      const path = paths[idx];
      try {
        const obj = await loadObj(path);
        obj.name = path;
        listRoot.add(obj);
      } catch (e) {
        failed.push({ path, error: e && e.message ? e.message : String(e) });
      }
    }
  });
  await Promise.all(workers);
  return { group: listRoot, failed };
}

function countTriangles(group) {
  let triangles = 0;
  group.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const geom = obj.geometry;
    if (geom.index) {
      triangles += Math.floor(geom.index.count / 3);
    } else if (geom.attributes && geom.attributes.position) {
      triangles += Math.floor(geom.attributes.position.count / 3);
    }
  });
  return triangles;
}

function setSelectedMesh(mesh) {
  if (selectedMesh && selectedMesh.material && selectedMeshEmissive) {
    selectedMesh.material.emissive.copy(selectedMeshEmissive);
  }
  selectedMesh = mesh;
  selectedMeshEmissive = null;
  if (selectedMesh && selectedMesh.material && selectedMesh.material.emissive) {
    selectedMeshEmissive = selectedMesh.material.emissive.clone();
    selectedMesh.material.emissive.setHex(0xffd166);
  }
}

function getDisplayName(path) {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

function rebuildObjectMenu() {
  objectListEl.innerHTML = "";
  meshRowMap.clear();
  objectById.clear();
  const groups = [
    { key: "collision", group: collisionGroup, enabled: showCollisionEl.checked },
    { key: "walkable", group: walkableGroup, enabled: showWalkableEl.checked },
  ];
  for (const entry of groups) {
    if (!entry.group) continue;
    for (const child of entry.group.children) {
      const row = document.createElement("label");
      row.className = "obj-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = entry.enabled && child.visible;
      checkbox.addEventListener("change", () => {
        child.visible = checkbox.checked;
      });
      const text = document.createElement("span");
      text.textContent = `[${entry.key}] ${getDisplayName(child.name || "unnamed")}`;
      row.appendChild(checkbox);
      row.appendChild(text);
      objectListEl.appendChild(row);
      row.dataset.meshId = child.uuid;
      meshRowMap.set(child.uuid, row);
      objectById.set(child.uuid, child);
      row.addEventListener("dblclick", () => {
        const target = objectById.get(row.dataset.meshId);
        if (target) focusAndHighlightTarget(target);
      });
    }
  }
}

function highlightObjectRow(mesh) {
  for (const row of meshRowMap.values()) {
    row.style.background = "";
  }
  if (!mesh) return;
  let node = mesh;
  while (node && !meshRowMap.has(node.uuid)) {
    node = node.parent;
  }
  if (!node) return;
  const row = meshRowMap.get(node.uuid);
  if (!row) return;
  row.style.background = "rgba(110, 231, 255, 0.2)";
  row.scrollIntoView({ block: "nearest" });
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
  controls.update();
}

function firstMeshInObject(target) {
  if (!target) return null;
  if (target.isMesh) return target;
  let found = null;
  target.traverse((obj) => {
    if (!found && obj.isMesh) found = obj;
  });
  return found;
}

function isObjectHierarchyVisible(obj) {
  let cur = obj;
  while (cur) {
    if (cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

function focusAndHighlightTarget(target) {
  if (!target) return;
  focusCameraToObject(target);
  const mesh = firstMeshInObject(target);
  setSelectedMesh(mesh);
  highlightObjectRow(mesh || target);
  const src = target.name || (mesh ? mesh.name : "mesh");
  setStatus(`focused: ${getDisplayName(src)}`);
}

function exportEnabledList() {
  const items = [];
  for (const groupEntry of [
    { key: "collision", group: collisionGroup },
    { key: "walkable", group: walkableGroup },
  ]) {
    if (!groupEntry.group) continue;
    for (const child of groupEntry.group.children) {
      if (!child.visible) continue;
      items.push({
        kind: groupEntry.key,
        path: child.name || "",
      });
    }
  }
  const text = items.map((x) => `${x.kind}\t${x.path}`).join("\n");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "enabled-meshes.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  setStatus(`exported enabled meshes: ${items.length}`);
}

function fitCameraToRoot() {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.6 + 1;
  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.8, radius));
  controls.target.copy(center);
  controls.update();
}

async function loadObj(path) {
  const parsed = await objWorkerPool.parse(path);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
  if (parsed.indices && parsed.indices.length > 0) {
    geom.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
  }
  geom.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  const group = new THREE.Group();
  group.add(mesh);
  if (APPLY_Z_FLIP) {
    group.scale.z *= -1;
    group.updateMatrixWorld(true);
  }
  return group;
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

async function loadImportListConfig() {
  const importListUrl = importListPathEl.value.trim() || "./import-list.json";
  const res = await fetch(importListUrl, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`failed to fetch ${importListUrl}: ${res.status}`);
  }
  const cfg = await res.json();
  return {
    collision: Array.isArray(cfg.collision) ? cfg.collision : [],
    walkable: Array.isArray(cfg.walkable) ? cfg.walkable : [],
  };
}

async function reload() {
  setStatus("loading...");
  loadBtn.disabled = true;
  try {
    if (collisionGroup) root.remove(collisionGroup);
    if (walkableGroup) root.remove(walkableGroup);
    collisionGroup = null;
    walkableGroup = null;

    const cfg = await loadImportListConfig();
    const collisionPaths = cfg.collision;
    const walkablePaths = cfg.walkable;

    const [cResult, wResult] = await Promise.all([loadObjList(collisionPaths), loadObjList(walkablePaths)]);
    collisionGroup = cResult.group;
    walkableGroup = wResult.group;
    root.add(collisionGroup);
    root.add(walkableGroup);

    applyMaterial(collisionGroup, 0x94a3b8, 1.0, wireframeEl.checked);
    applyMaterial(walkableGroup, 0x22d3ee, 1.0, wireframeEl.checked);
    collisionGroup.visible = showCollisionEl.checked;
    walkableGroup.visible = showWalkableEl.checked;
    setSelectedMesh(null);
    highlightObjectRow(null);
    lastHitPoint = null;
    rebuildObjectMenu();

    const collisionFaces = countTriangles(collisionGroup);
    const walkableFaces = countTriangles(walkableGroup);
    const totalFaces = collisionFaces + walkableFaces;
    const failCount = cResult.failed.length + wResult.failed.length;

    fitCameraToRoot();
    setStatus(
      `loaded\ncollision files: ${collisionGroup.children.length}/${collisionPaths.length}, faces: ${collisionFaces}\nwalkable files: ${walkableGroup.children.length}/${walkablePaths.length}, faces: ${walkableFaces}\ntotal faces: ${totalFaces}\nfailed files: ${failCount}`
    );
  } catch (e) {
    setStatus(`load failed: ${e.message || e}`, true);
  } finally {
    loadBtn.disabled = false;
  }
}

showCollisionEl.addEventListener("change", () => {
  if (collisionGroup) {
    collisionGroup.visible = showCollisionEl.checked;
    for (const child of collisionGroup.children) {
      child.visible = showCollisionEl.checked;
    }
    rebuildObjectMenu();
  }
});

showWalkableEl.addEventListener("change", () => {
  if (walkableGroup) {
    walkableGroup.visible = showWalkableEl.checked;
    for (const child of walkableGroup.children) {
      child.visible = showWalkableEl.checked;
    }
    rebuildObjectMenu();
  }
});

wireframeEl.addEventListener("change", () => {
  if (collisionGroup) applyMaterial(collisionGroup, 0x94a3b8, 1.0, wireframeEl.checked);
  if (walkableGroup) applyMaterial(walkableGroup, 0x22d3ee, 1.0, wireframeEl.checked);
});

loadBtn.addEventListener("click", reload);
fitBtn.addEventListener("click", fitCameraToRoot);
exportEnabledBtn.addEventListener("click", exportEnabledList);
renderer.domElement.addEventListener("click", (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseNdc, camera);
  const hits = raycaster.intersectObjects(root.children, true);
  const first = hits.find((h) => h.object && h.object.isMesh && isObjectHierarchyVisible(h.object));
  if (!first) {
    setSelectedMesh(null);
    highlightObjectRow(null);
    lastHitPoint = null;
    setStatus("no hit");
    return;
  }
  setSelectedMesh(first.object);
  highlightObjectRow(first.object);
  lastHitPoint = first.point.clone();
  const src = first.object.parent && first.object.parent.name ? first.object.parent.name : first.object.name;
  setStatus(`picked: ${getDisplayName(src || "mesh")}`);
});
renderer.domElement.addEventListener("dblclick", (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseNdc, camera);
  const hits = raycaster.intersectObjects(root.children, true);
  const first = hits.find((h) => h.object && h.object.isMesh && isObjectHierarchyVisible(h.object));
  if (!first) return;
  focusAndHighlightTarget(first.object);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
reload();
