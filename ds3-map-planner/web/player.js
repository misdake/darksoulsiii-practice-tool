import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSM } from "three/addons/csm/CSM.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js";

const app = document.getElementById("app");
const mapSelectEl = document.getElementById("mapSelect");
const loadBtn = document.getElementById("loadBtn");
const modeBtn = document.getElementById("modeBtn");
const showHf22El = document.getElementById("showHf22");
const statusEl = document.getElementById("status");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);
const composer = new EffectComposer(renderer);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1115);
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(40, 35, 40);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
ssaoPass.kernelRadius = 6;
ssaoPass.minDistance = 0.01;
ssaoPass.maxDistance = 0.06;
composer.addPass(ssaoPass);
composer.addPass(new OutputPass());

scene.add(new THREE.AmbientLight(0xffffff, 0.8));

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
  lightIntensity: 0.9,
  lightNear: 1,
  lightFar: 1800,
  shadowBias: 0.00035,
  fade: true,
});

const raycaster = new THREE.Raycaster();
const mouseNdc = new THREE.Vector2();
const objWorkerPool = createObjWorkerPool(Math.max(2, Math.min(8, Math.floor((navigator.hardwareConcurrency || 8) / 2))));

const MOVE_SPEED = 6.6;
const JUMP_SPEED = 6.8;
const GRAVITY = 27.5;
const SPRINT_MULTIPLIER = 4.0;
const CAM_DIST = 5.8;
const CAM_HEIGHT = 2.3;
const DEFAULT_VISIBLE_COLLISION_HIT_FILTERS = new Set([8]);
const PHYSICS_ONLY_COLLISION_HIT_FILTERS = new Set([22]);
const PLAYER_RADIUS = 0.30;
const PLAYER_SEGMENT = 0.96;

const playerSphere = new THREE.Mesh(
  new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_SEGMENT, 8, 16),
  new THREE.MeshStandardMaterial({ color: 0x87f5b1, transparent: true, opacity: 0.8 })
);
playerSphere.castShadow = true;
playerSphere.receiveShadow = true;
csm.setupMaterial(playerSphere.material);
scene.add(playerSphere);

let collisionGroup = null;
let currentMapId = "";
let thirdPersonMode = false;
let pointerLocked = false;
const keys = new Set();
const mouseLook = { yaw: 0, pitch: -0.25 };
let freeClickDown = false;
let freeClickMoved = false;
let freeClickStartX = 0;
let freeClickStartY = 0;

let rapier = null;
let world = null;
let characterController = null;
let playerBody = null;
let playerCollider = null;
let worldBodies = [];
let worldColliders = [];
let verticalVelocity = 0;
let grounded = false;
let desiredCamDistance = CAM_DIST;

function setStatus(msg, isError = false) {
  statusEl.style.color = isError ? "#ff9f9f" : "#87f5b1";
  statusEl.textContent = msg;
}

function updateModeButtonText() {
  modeBtn.textContent = thirdPersonMode ? "Switch To Free Camera" : "Enter Third-Person";
}

function applyHf22Visibility() {
  if (!collisionGroup) return;
  const show = !!(showHf22El && showHf22El.checked);
  for (const g of collisionGroup.children) {
    if (Number(g.userData?.hitFilter) === 22) {
      g.visible = show;
    }
  }
}

function displayName(path) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.json();
}

async function loadMapList() {
  const data = await fetchJson("/api/maps");
  mapSelectEl.innerHTML = "";
  for (const item of data.maps || []) {
    const opt = document.createElement("option");
    opt.value = item.map_id;
    opt.textContent = `${item.map_id} - ${item.display_name || item.map_id}`;
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
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.7,
      metalness: 0.0,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      transparent: false,
      opacity: 1.0,
    })
  );
  const group = new THREE.Group();
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  csm.setupMaterial(mesh.material);
  group.add(mesh);
  group.scale.z = -1;
  return group;
}

function clearPhysicsWorld() {
  if (!world) return;
  for (const c of worldColliders) world.removeCollider(c, false);
  for (const b of worldBodies) world.removeRigidBody(b);
  worldBodies = [];
  worldColliders = [];
}

function addTrimeshColliderFromMesh(mesh) {
  if (!mesh.geometry) return 0;
  const geom = mesh.geometry;
  const pos = geom.attributes.position;
  if (!pos || pos.count === 0) return 0;

  const worldMat = mesh.matrixWorld;
  const vertices = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(worldMat);
    vertices[i * 3 + 0] = v.x;
    vertices[i * 3 + 1] = v.y;
    vertices[i * 3 + 2] = v.z;
  }

  let indices;
  if (geom.index) {
    const src = geom.index.array;
    indices = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      indices[i + 0] = src[i + 0];
      indices[i + 1] = src[i + 2];
      indices[i + 2] = src[i + 1];
    }
  } else {
    const triCount = Math.floor(pos.count / 3);
    indices = new Uint32Array(triCount * 3);
    for (let i = 0; i < triCount; i++) {
      const b = i * 3;
      indices[b + 0] = b + 0;
      indices[b + 1] = b + 2;
      indices[b + 2] = b + 1;
    }
  }

  const rb = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const cd = rapier.ColliderDesc.trimesh(vertices, indices);
  const co = world.createCollider(cd, rb);
  worldBodies.push(rb);
  worldColliders.push(co);
  return Math.floor(indices.length / 3);
}

function rebuildPhysicsWorld() {
  if (!world) return { triCount: 0, colliders: 0 };
  clearPhysicsWorld();
  if (!collisionGroup) return { triCount: 0, colliders: 0 };
  collisionGroup.updateMatrixWorld(true);
  let triCount = 0;
  let colliders = 0;
  collisionGroup.traverse((obj) => {
    if (!obj.isMesh) return;
    triCount += addTrimeshColliderFromMesh(obj);
    colliders += 1;
  });
  return { triCount, colliders };
}

function ensurePlayerPhysics() {
  if (!world || !rapier) return;
  if (playerBody && playerCollider) return;
  playerBody = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 3, 0));
  const cd = rapier.ColliderDesc.capsule(PLAYER_SEGMENT * 0.5, PLAYER_RADIUS).setFriction(0.0).setRestitution(0.0);
  playerCollider = world.createCollider(cd, playerBody);
  characterController = world.createCharacterController(0.008);
  characterController.setMaxSlopeClimbAngle((56 * Math.PI) / 180);
  characterController.setMinSlopeSlideAngle((64 * Math.PI) / 180);
  if (typeof characterController.enableAutostep === "function") {
    characterController.enableAutostep(0.42, 0.24, true);
  }
  verticalVelocity = 0;
  grounded = false;
}

function setPlayerPosition(x, y, z) {
  ensurePlayerPhysics();
  if (!playerBody) return;
  // Apply immediately to avoid one-step lag on click teleport.
  playerBody.setTranslation({ x, y, z }, true);
  playerBody.setNextKinematicTranslation({ x, y, z });
  playerSphere.position.set(x, y, z);
  verticalVelocity = 0;
  grounded = false;
}

function placePlayerFromCameraTarget() {
  const p = controls.target.clone();
  setPlayerPosition(p.x, p.y + PLAYER_RADIUS + 0.4 + PLAYER_SEGMENT * 0.5, p.z);
}

function placePlayerAtHitPoint(hitPoint) {
  setPlayerPosition(hitPoint.x, hitPoint.y + PLAYER_RADIUS + 0.45 + PLAYER_SEGMENT * 0.5, hitPoint.z);
}

async function reloadCollision() {
  const mapId = mapSelectEl.value;
  if (!mapId) return;
  currentMapId = mapId;
  setStatus(`loading collision ${mapId} ...`);
  loadBtn.disabled = true;
  try {
    const t0 = performance.now();
    const payload = await fetchJson(`/api/maps/${mapId}/content`);
    const rawCollisionEntries = (payload.collision_manifest.instances || []).map((x) => ({
      path: x.OutObjFile,
      hitFilter: Number.isFinite(x.MsbHitFilterId) ? x.MsbHitFilterId : 255,
    }));
    const enabledSet = payload.saved_profile_exists && payload.saved_profile
      ? new Set(payload.saved_profile.collision_enabled_paths || [])
      : null;
    const collisionEntries = rawCollisionEntries.filter((x) => {
      if (PHYSICS_ONLY_COLLISION_HIT_FILTERS.has(x.hitFilter)) return true;
      if (enabledSet) return enabledSet.has(x.path);
      return DEFAULT_VISIBLE_COLLISION_HIT_FILTERS.has(x.hitFilter);
    });

    if (collisionGroup) root.remove(collisionGroup);
    collisionGroup = new THREE.Group();

    let done = 0;
    for (const entry of collisionEntries) {
      try {
        const g = await loadObj(entry.path);
        g.name = entry.path;
        g.userData.hitFilter = entry.hitFilter;
        g.visible = !PHYSICS_ONLY_COLLISION_HIT_FILTERS.has(entry.hitFilter);
        collisionGroup.add(g);
      } catch { }
      done += 1;
      setStatus(
        `loading collision ${mapId} ${done}/${collisionEntries.length}\n` +
        `all objs: ${rawCollisionEntries.length}\n` +
        `loaded by profile/default + physics-only(22): ${collisionEntries.length}`
      );
    }
    root.add(collisionGroup);
    applyHf22Visibility();
    fitCamera();

    if (!world || !rapier) {
      setStatus("rapier not ready, loaded render meshes only", true);
      return;
    }
    setStatus("building rapier colliders ...");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const pt0 = performance.now();
    const info = rebuildPhysicsWorld();
    ensurePlayerPhysics();
    const pMs = performance.now() - pt0;

    placePlayerFromCameraTarget();
    const totalMs = performance.now() - t0;
    setStatus(
      `loaded ${mapId}\n` +
      `objs(all/kept): ${rawCollisionEntries.length}/${collisionGroup.children.length}\n` +
      `trimesh colliders: ${info.colliders}\n` +
      `tris: ${info.triCount}\n` +
      `rapier build: ${pMs.toFixed(1)} ms\n` +
      `total: ${totalMs.toFixed(1)} ms`
    );
  } catch (e) {
    setStatus(`load failed: ${e.message || e}`, true);
  } finally {
    loadBtn.disabled = false;
  }
}

function fitCamera() {
  if (!collisionGroup || collisionGroup.children.length === 0) return;
  const box = new THREE.Box3().setFromObject(collisionGroup);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.55 + 1;
  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.65, radius));
  controls.target.copy(center);
}

function getForwardFlat() {
  const out = new THREE.Vector3();
  camera.getWorldDirection(out);
  out.y = 0;
  if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
  return out.normalize();
}

function updateThirdPerson(delta) {
  if (!world || !playerBody || !characterController || !playerCollider) return;

  const p = playerBody.translation();
  const forward = new THREE.Vector3(
    Math.sin(mouseLook.yaw) * Math.cos(mouseLook.pitch),
    0,
    Math.cos(mouseLook.yaw) * Math.cos(mouseLook.pitch)
  ).normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const move = new THREE.Vector3();
  if (keys.has("KeyW")) move.add(forward);
  if (keys.has("KeyS")) move.sub(forward);
  if (keys.has("KeyD")) move.add(right);
  if (keys.has("KeyA")) move.sub(right);
  if (move.lengthSq() > 0) {
    move.normalize();
    const speed = MOVE_SPEED;
    const sprint = keys.has("ShiftLeft") || keys.has("ShiftRight");
    move.multiplyScalar(speed * (sprint ? SPRINT_MULTIPLIER : 1.0) * delta);
  }

  verticalVelocity -= GRAVITY * delta;
  if (grounded && keys.has("Space")) {
    verticalVelocity = JUMP_SPEED;
    grounded = false;
  }

  const requested = { x: move.x, y: verticalVelocity * delta, z: move.z };
  characterController.computeColliderMovement(playerCollider, requested);
  const corrected = characterController.computedMovement();
  let mx = corrected.x;
  let my = corrected.y;
  let mz = corrected.z;
  const willBeGrounded = characterController.computedGrounded();
  const next = { x: p.x + mx, y: p.y + my, z: p.z + mz };
  playerBody.setNextKinematicTranslation(next);

  grounded = willBeGrounded;
  if (grounded && verticalVelocity < 0) verticalVelocity = 0;

  const np = playerBody.translation();
  playerSphere.position.set(np.x, np.y, np.z);

  const center = new THREE.Vector3(np.x, np.y, np.z);
  const lookDir = new THREE.Vector3(
    Math.sin(mouseLook.yaw) * Math.cos(mouseLook.pitch),
    Math.sin(mouseLook.pitch),
    Math.cos(mouseLook.yaw) * Math.cos(mouseLook.pitch)
  ).normalize();
  const desiredCamPos = center.clone().addScaledVector(lookDir, -desiredCamDistance).add(new THREE.Vector3(0, CAM_HEIGHT, 0));
  const camPos = adjustCameraForObstruction(center, desiredCamPos);
  camera.position.lerp(camPos, 0.12);
  controls.target.lerp(center, 0.18);
}

function adjustCameraForObstruction(targetPos, desiredCamPos) {
  if (!collisionGroup) return desiredCamPos;
  const toCam = desiredCamPos.clone().sub(targetPos);
  const dist = toCam.length();
  if (dist < 1e-4) return desiredCamPos;
  const dir = toCam.clone().multiplyScalar(1 / dist);
  const prevFar = raycaster.far;
  raycaster.set(targetPos, dir);
  raycaster.far = dist;
  const hits = raycaster.intersectObjects(collisionGroup.children, true);
  raycaster.far = prevFar;
  const first = hits.find((h) => {
    if (!h.object || !h.object.isMesh) return false;
    let cur = h.object;
    while (cur) {
      if (cur.visible === false) return false;
      cur = cur.parent;
    }
    return true;
  });
  if (!first) return desiredCamPos;
  const safeDist = Math.max(1.1, first.distance - 0.18);
  return targetPos.clone().addScaledVector(dir, safeDist);
}

function updateFreeCamera() {
  controls.enabled = true;
}

function setThirdPersonMode(enabled) {
  thirdPersonMode = enabled;
  updateModeButtonText();
  controls.enabled = !enabled;
  if (!enabled) {
    verticalVelocity = 0;
    document.exitPointerLock?.();
  }
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
      p.resolve({ positions: new Float32Array(msg.positions), indices: msg.indices ? new Uint32Array(msg.indices) : null });
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

loadBtn.addEventListener("click", reloadCollision);
modeBtn.addEventListener("click", () => setThirdPersonMode(!thirdPersonMode));
if (showHf22El) {
  showHf22El.addEventListener("change", () => {
    applyHf22Visibility();
  });
}

window.addEventListener("keydown", (event) => {
  if (event.code === "KeyF") {
    setThirdPersonMode(!thirdPersonMode);
    return;
  }
  keys.add(event.code);
});
window.addEventListener("keyup", (event) => keys.delete(event.code));

renderer.domElement.addEventListener("click", () => {
  if (!thirdPersonMode) return;
  renderer.domElement.requestPointerLock?.();
});
renderer.domElement.addEventListener("pointerdown", (event) => {
  if (thirdPersonMode || event.button !== 0) return;
  freeClickDown = true;
  freeClickMoved = false;
  freeClickStartX = event.clientX;
  freeClickStartY = event.clientY;
});
renderer.domElement.addEventListener("pointermove", (event) => {
  if (!freeClickDown) return;
  const dx = event.clientX - freeClickStartX;
  const dy = event.clientY - freeClickStartY;
  if (dx * dx + dy * dy > 16) freeClickMoved = true;
});
renderer.domElement.addEventListener("pointerup", (event) => {
  if (!freeClickDown) return;
  freeClickDown = false;
  if (thirdPersonMode || freeClickMoved || event.button !== 0 || !collisionGroup) return;
  camera.updateMatrixWorld(true);
  collisionGroup.updateMatrixWorld(true);
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.far = Infinity;
  raycaster.setFromCamera(mouseNdc, camera);
  const hits = raycaster.intersectObjects(collisionGroup.children, true);
  const first = hits.find((h) => {
    if (!h.object || !h.object.isMesh) return false;
    let cur = h.object;
    while (cur) {
      if (cur.visible === false) return false;
      cur = cur.parent;
    }
    return true;
  });
  if (!first) return;
  placePlayerAtHitPoint(first.point);
  setStatus(
    `character placed.\n` +
    `next step: click "Enter Third-Person" to start moving.\n` +
    `pos: ${first.point.x.toFixed(2)}, ${first.point.y.toFixed(2)}, ${first.point.z.toFixed(2)}`
  );
});

document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
window.addEventListener("mousemove", (event) => {
  if (!thirdPersonMode || !pointerLocked) return;
  mouseLook.yaw -= event.movementX * 0.0022;
  mouseLook.pitch -= event.movementY * 0.0016;
  mouseLook.pitch = Math.max(-1.2, Math.min(0.8, mouseLook.pitch));
});
window.addEventListener("wheel", (event) => {
  if (!thirdPersonMode) return;
  desiredCamDistance += event.deltaY * 0.003;
  desiredCamDistance = Math.max(2.0, Math.min(12.0, desiredCamDistance));
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  ssaoPass.setSize(window.innerWidth, window.innerHeight);
  csm.updateFrustums();
});

const clock = new THREE.Clock();
function animate() {
  const delta = Math.min(0.033, clock.getDelta());
  if (thirdPersonMode) {
    updateThirdPerson(delta);
  } else {
    updateFreeCamera();
  }
  if (world) world.step();
  csm.update();
  controls.update();
  composer.render();
  requestAnimationFrame(animate);
}

async function init() {
  setStatus("initializing rapier ...");
  try {
    await RAPIER.init({});
    rapier = RAPIER;
    world = new rapier.World({ x: 0, y: -24, z: 0 });
  } catch (e) {
    setStatus(`rapier init failed: ${e.message || e}`, true);
  }
  await loadMapList();
  setThirdPersonMode(false);
  updateModeButtonText();
  if (mapSelectEl.value) {
    await reloadCollision();
    setStatus(
      "map loaded.\n" +
      "step 1: click the ground to place character.\n" +
      "step 2: click \"Enter Third-Person\"."
    );
  } else {
    setStatus("no map available", true);
  }
}

animate();
init().catch((e) => setStatus(`init failed: ${e.message || e}`, true));









