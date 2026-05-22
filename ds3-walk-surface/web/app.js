import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {EffectComposer} from "three/addons/postprocessing/EffectComposer.js";
import {RenderPass} from "three/addons/postprocessing/RenderPass.js";
import {SSAOPass} from "three/addons/postprocessing/SSAOPass.js";
import {OutlinePass} from "three/addons/postprocessing/OutlinePass.js";
import {SMAAPass} from "three/addons/postprocessing/SMAAPass.js";
import {OutputPass} from "three/addons/postprocessing/OutputPass.js";
import {CSM} from "three/addons/csm/CSM.js";

const app = document.getElementById("app");
const collisionJsonPathEl = document.getElementById("collisionJsonPath");
const showCollisionEl = document.getElementById("showCollision");
const showWalkableEl = document.getElementById("showWalkable");
const loadBtn = document.getElementById("loadBtn");
const fitBtn = document.getElementById("fitBtn");
const exportEnabledBtn = document.getElementById("exportEnabledBtn");
const statusEl = document.getElementById("status");
const objectListEl = document.getElementById("objectList");
const hitFilterListEl = document.getElementById("hitFilterList");
const csmEnabledEl = document.getElementById("csmEnabled");
const csmMaxFarEl = document.getElementById("csmMaxFar");
const csmIntensityEl = document.getElementById("csmIntensity");
const csmShadowBiasEl = document.getElementById("csmShadowBias");
const csmNormalBiasEl = document.getElementById("csmNormalBias");
const csmShadowRadiusEl = document.getElementById("csmShadowRadius");
const csmMaxFarValEl = document.getElementById("csmMaxFarVal");
const csmIntensityValEl = document.getElementById("csmIntensityVal");
const csmShadowBiasValEl = document.getElementById("csmShadowBiasVal");
const csmNormalBiasValEl = document.getElementById("csmNormalBiasVal");
const csmShadowRadiusValEl = document.getElementById("csmShadowRadiusVal");
const ssaoEnabledEl = document.getElementById("ssaoEnabled");
const ssaoKernelEl = document.getElementById("ssaoKernel");
const ssaoMinDistEl = document.getElementById("ssaoMinDist");
const ssaoMaxDistEl = document.getElementById("ssaoMaxDist");
const ssaoKernelValEl = document.getElementById("ssaoKernelVal");
const ssaoMinDistValEl = document.getElementById("ssaoMinDistVal");
const ssaoMaxDistValEl = document.getElementById("ssaoMaxDistVal");
const smaaEnabledEl = document.getElementById("smaaEnabled");
const toneMappingEnabledEl = document.getElementById("toneMappingEnabled");
const toneExposureEl = document.getElementById("toneExposure");
const toneExposureValEl = document.getElementById("toneExposureVal");
const outlineEnabledEl = document.getElementById("outlineEnabled");
const outlineStrengthEl = document.getElementById("outlineStrength");
const outlineThicknessEl = document.getElementById("outlineThickness");
const outlineStrengthValEl = document.getElementById("outlineStrengthVal");
const outlineThicknessValEl = document.getElementById("outlineThicknessVal");
const resetCsmBtn = document.getElementById("resetCsmBtn");
const resetSsaoBtn = document.getElementById("resetSsaoBtn");
const resetSmaaBtn = document.getElementById("resetSmaaBtn");
const resetToneBtn = document.getElementById("resetToneBtn");
const resetOutlineBtn = document.getElementById("resetOutlineBtn");

const renderer = new THREE.WebGLRenderer({antialias: true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.getContext().disable(renderer.getContext().CULL_FACE);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1115);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 1000);
camera.position.set(100, 80, 100);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

const ambient = new THREE.AmbientLight(0xffffff, 0.62);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x202636, 0.26);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.42);
dir.position.set(120, 220, 100);
scene.add(dir);
const BASE_AMBIENT_INTENSITY = 0.62;
const BASE_HEMI_INTENSITY = 0.26;
const BASE_DIR_INTENSITY = 0.42;

const grid = new THREE.GridHelper(600, 60, 0x2a3342, 0x1f2733);
grid.position.y = -70;
grid.receiveShadow = true;
scene.add(grid);

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

const composer = new EffectComposer(renderer);
composer.setPixelRatio(renderer.getPixelRatio());
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
ssaoPass.kernelRadius = 2;
ssaoPass.minDistance = 0.0001;
ssaoPass.maxDistance = 0.002;
ssaoPass.output = SSAOPass.OUTPUT.Default;
composer.addPass(ssaoPass);
const outlinePass = new OutlinePass(new THREE.Vector2(window.innerWidth, window.innerHeight), scene, camera);
outlinePass.edgeStrength = 4.0;
outlinePass.edgeGlow = 0.0;
outlinePass.edgeThickness = 1.8;
outlinePass.visibleEdgeColor.set("#ffd166");
outlinePass.hiddenEdgeColor.set("#8b5e00");
composer.addPass(outlinePass);
const smaaPass = new SMAAPass(window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());
composer.addPass(smaaPass);
const outputPass = new OutputPass();
composer.addPass(outputPass);

const raycaster = new THREE.Raycaster();
const mouseNdc = new THREE.Vector2();
const APPLY_Z_FLIP = true;
const LOAD_CONCURRENCY = 8;
const WORKER_COUNT = Math.max(2, Math.min(8, Math.floor((navigator.hardwareConcurrency || 8) / 2)));
const DEFAULT_ENABLED_HIT_FILTER_IDS = new Set([8, 22]);
const CSM_DEFAULTS = {enabled: true, maxFar: "1500", intensity: "1.0", shadowBias: "-0.0002", normalBias: "0.9", shadowRadius: "2.0"};
const SSAO_DEFAULTS = {enabled: false, kernel: "2", minDist: "0.0001", maxDist: "0.002"};
const SMAA_DEFAULTS = {enabled: true};
const TONE_DEFAULTS = {enabled: true, exposure: "1.1"};
const OUTLINE_DEFAULTS = {enabled: true, strength: "4.0", thickness: "1.8"};
let collisionGroup = null;
let walkableGroup = null;
let selectedMesh = null;
let lastHitPoint = null;
const meshRowMap = new Map();
const objectById = new Map();
const instanceMetaByGroupId = new Map();
const hitFilterEnabled = new Map();
const objWorkerPool = createObjWorkerPool(WORKER_COUNT);
let pointerDown = false;
let pointerDownX = 0;
let pointerDownY = 0;
let suppressNextClick = false;

function updateDisplaySettings() {
    const csmEnabled = !!csmEnabledEl.checked;
    const csmMaxFar = Number(csmMaxFarEl.value);
    const csmIntensity = Number(csmIntensityEl.value);
    const csmShadowBias = Number(csmShadowBiasEl.value);
    const csmNormalBias = Number(csmNormalBiasEl.value);
    const csmShadowRadius = Number(csmShadowRadiusEl.value);
    const ssaoEnabled = !!ssaoEnabledEl.checked;
    const ssaoKernel = Number(ssaoKernelEl.value);
    const ssaoMinDist = Number(ssaoMinDistEl.value);
    const ssaoMaxDist = Number(ssaoMaxDistEl.value);
    const smaaEnabled = !!smaaEnabledEl.checked;
    const toneEnabled = !!toneMappingEnabledEl.checked;
    const toneExposure = Number(toneExposureEl.value);
    const outlineEnabled = !!outlineEnabledEl.checked;
    const outlineStrength = Number(outlineStrengthEl.value);
    const outlineThickness = Number(outlineThicknessEl.value);

    csmMaxFarValEl.textContent = csmMaxFarEl.value;
    csmIntensityValEl.textContent = csmIntensityEl.value;
    csmShadowBiasValEl.textContent = csmShadowBiasEl.value;
    csmNormalBiasValEl.textContent = csmNormalBiasEl.value;
    csmShadowRadiusValEl.textContent = csmShadowRadiusEl.value;
    ssaoKernelValEl.textContent = ssaoKernelEl.value;
    ssaoMinDistValEl.textContent = ssaoMinDistEl.value;
    ssaoMaxDistValEl.textContent = ssaoMaxDistEl.value;
    toneExposureValEl.textContent = toneExposureEl.value;
    outlineStrengthValEl.textContent = outlineStrengthEl.value;
    outlineThicknessValEl.textContent = outlineThicknessEl.value;

    csm.fade = csmEnabled;
    csm.maxFar = csmMaxFar;
    csm.updateFrustums();
    for (const light of csm.lights) {
        light.intensity = csmEnabled ? csmIntensity : 0.0;
        light.shadow.bias = csmShadowBias;
        light.shadow.normalBias = csmNormalBias;
        light.shadow.radius = csmShadowRadius;
    }

    ssaoPass.enabled = ssaoEnabled;
    ssaoPass.kernelRadius = ssaoKernel;
    ssaoPass.minDistance = ssaoMinDist;
    ssaoPass.maxDistance = ssaoMaxDist;
    smaaPass.enabled = smaaEnabled;
    outlinePass.enabled = outlineEnabled;
    outlinePass.edgeStrength = outlineStrength;
    outlinePass.edgeThickness = outlineThickness;
    renderer.toneMapping = toneEnabled ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = toneExposure;

    // Compensate global brightness shift caused by SSAO darkening.
    const ssaoComp = ssaoEnabled ? 1.12 : 1.0;
    ambient.intensity = BASE_AMBIENT_INTENSITY * ssaoComp;
    hemi.intensity = BASE_HEMI_INTENSITY * ssaoComp;
    dir.intensity = BASE_DIR_INTENSITY * ssaoComp;
}

function resetCsmDefaults() {
    csmEnabledEl.checked = CSM_DEFAULTS.enabled;
    csmMaxFarEl.value = CSM_DEFAULTS.maxFar;
    csmIntensityEl.value = CSM_DEFAULTS.intensity;
    csmShadowBiasEl.value = CSM_DEFAULTS.shadowBias;
    csmNormalBiasEl.value = CSM_DEFAULTS.normalBias;
    csmShadowRadiusEl.value = CSM_DEFAULTS.shadowRadius;
    updateDisplaySettings();
}

function resetSsaoDefaults() {
    ssaoEnabledEl.checked = SSAO_DEFAULTS.enabled;
    ssaoKernelEl.value = SSAO_DEFAULTS.kernel;
    ssaoMinDistEl.value = SSAO_DEFAULTS.minDist;
    ssaoMaxDistEl.value = SSAO_DEFAULTS.maxDist;
    updateDisplaySettings();
}

function resetSmaaDefaults() {
    smaaEnabledEl.checked = SMAA_DEFAULTS.enabled;
    updateDisplaySettings();
}

function resetToneDefaults() {
    toneMappingEnabledEl.checked = TONE_DEFAULTS.enabled;
    toneExposureEl.value = TONE_DEFAULTS.exposure;
    updateDisplaySettings();
}

function resetOutlineDefaults() {
    outlineEnabledEl.checked = OUTLINE_DEFAULTS.enabled;
    outlineStrengthEl.value = OUTLINE_DEFAULTS.strength;
    outlineThicknessEl.value = OUTLINE_DEFAULTS.thickness;
    updateDisplaySettings();
}

function setStatus(msg, isError = false) {
    statusEl.style.color = isError ? "#ff9f9f" : "#87f5b1";
    const hitText = lastHitPoint
        ? `\nhit: x=${lastHitPoint.x.toFixed(3)}, y=${lastHitPoint.y.toFixed(3)}, z=${lastHitPoint.z.toFixed(3)}`
        : "";
    statusEl.textContent = `${msg}${hitText}`;
}

function applyMaterial(group, color, opacity) {
    group.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.material = new THREE.MeshStandardMaterial({
            color,
            roughness: 0.68,
            metalness: 0.0,
            transparent: false,
            opacity: 1.0,
            side: THREE.DoubleSide,
            shadowSide: THREE.DoubleSide,
        });
        obj.castShadow = true;
        obj.receiveShadow = true;
        csm.setupMaterial(obj.material);
    });
}

async function loadObjList(entries) {
    const listRoot = new THREE.Group();
    const failed = [];
    let cursor = 0;
    const workers = Array.from({length: Math.min(LOAD_CONCURRENCY, entries.length)}, async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= entries.length) break;
            const entry = entries[idx];
            const path = entry.path;
            try {
                const obj = await loadObj(path);
                obj.name = path;
                obj.userData.meta = entry;
                listRoot.add(obj);
            } catch (e) {
                failed.push({path, error: e && e.message ? e.message : String(e)});
            }
        }
    });
    await Promise.all(workers);
    return {group: listRoot, failed};
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
    selectedMesh = mesh;
    outlinePass.selectedObjects = selectedMesh ? [selectedMesh] : [];
}

function getDisplayName(path) {
    const lastSlash = path.lastIndexOf("/");
    return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

function getInstanceMetaFromTarget(target) {
    if (!target) return null;
    let node = target;
    while (node) {
        if (node.userData && node.userData.meta) return node.userData.meta;
        node = node.parent;
    }
    return null;
}

function rebuildObjectMenu() {
    objectListEl.innerHTML = "";
    meshRowMap.clear();
    objectById.clear();
    const groups = [
        {key: "collision", group: collisionGroup, enabled: showCollisionEl.checked},
        {key: "walkable", group: walkableGroup, enabled: showWalkableEl.checked},
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
            instanceMetaByGroupId.set(child.uuid, child.userData && child.userData.meta ? child.userData.meta : null);
            row.addEventListener("dblclick", () => {
                const target = objectById.get(row.dataset.meshId);
                if (target) focusAndHighlightTarget(target);
            });
        }
    }
}

function rebuildHitFilterMenu() {
    hitFilterListEl.innerHTML = "";
    const rows = Array.from(hitFilterEnabled.entries()).sort((a, b) => a[0] - b[0]);
    for (const [id, state] of rows) {
        const row = document.createElement("label");
        row.className = "obj-item";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = state.enabled;
        checkbox.addEventListener("change", () => {
            state.enabled = checkbox.checked;
            hitFilterEnabled.set(id, state);
            applyCollisionVisibility();
        });
        const text = document.createElement("span");
        text.textContent = `${id} - ${state.type}`;
        row.appendChild(checkbox);
        row.appendChild(text);
        hitFilterListEl.appendChild(row);
    }
}

function applyCollisionVisibility() {
    if (!collisionGroup) return;
    for (const child of collisionGroup.children) {
        const meta = child.userData && child.userData.meta ? child.userData.meta : null;
        if (!meta) {
            child.visible = showCollisionEl.checked;
            continue;
        }
        const state = hitFilterEnabled.get(meta.msbHitFilterId);
        child.visible = showCollisionEl.checked && (!!state ? state.enabled : true);
    }
    rebuildObjectMenu();
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
    row.scrollIntoView({block: "nearest"});
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
    const meta = getInstanceMetaFromTarget(target);
    if (meta) {
        setStatus(`focused: ${getDisplayName(src)} | hitFilter=${meta.msbHitFilterId} (${meta.msbHitFilterType})`);
    } else {
        setStatus(`focused: ${getDisplayName(src)}`);
    }
}

function exportEnabledList() {
    const items = [];
    for (const groupEntry of [
        {key: "collision", group: collisionGroup},
        {key: "walkable", group: walkableGroup},
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
    const blob = new Blob([text], {type: "text/plain;charset=utf-8"});
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
        const w = new Worker("./obj-worker.js", {type: "module"});
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
                pending.set(id, {resolve, reject});
                const w = workers[nextWorker];
                nextWorker = (nextWorker + 1) % workers.length;
                w.postMessage({id, path});
            });
        },
    };
}

async function loadCollisionConfig() {
    const jsonUrl = collisionJsonPathEl.value.trim() || "/map-work/walk-surface-m40/collision_h40_world.json";
    const res = await fetch(jsonUrl, {cache: "no-store"});
    if (!res.ok) {
        throw new Error(`failed to fetch ${jsonUrl}: ${res.status}`);
    }
    const cfg = await res.json();
    const instances = Array.isArray(cfg.instances) ? cfg.instances : [];
    const collision = instances
        .filter((x) => x && typeof x.OutObjFile === "string")
        .map((x) => ({
            path: x.OutObjFile,
            sourceHkxFile: x.SourceHkxFile || "",
            instanceName: x.InstanceName || "",
            modelName: x.ModelName || "",
            msbHitFilterId: Number.isFinite(x.MsbHitFilterId) ? x.MsbHitFilterId : 255,
            msbHitFilterType: x.MsbHitFilterType || "Unknown",
        }));
    hitFilterEnabled.clear();
    for (const inst of collision) {
        if (!hitFilterEnabled.has(inst.msbHitFilterId)) {
            hitFilterEnabled.set(inst.msbHitFilterId, {
                enabled: DEFAULT_ENABLED_HIT_FILTER_IDS.has(inst.msbHitFilterId),
                type: inst.msbHitFilterType,
            });
        }
    }
    return {
        collision,
        walkable: [],
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

        const cfg = await loadCollisionConfig();
        const collisionEntries = cfg.collision;
        const walkableEntries = cfg.walkable;

        const [cResult, wResult] = await Promise.all([loadObjList(collisionEntries), loadObjList(walkableEntries)]);
        collisionGroup = cResult.group;
        walkableGroup = wResult.group;
        root.add(collisionGroup);
        root.add(walkableGroup);

        applyMaterial(collisionGroup, 0x94a3b8, 1.0);
        applyMaterial(walkableGroup, 0x22d3ee, 1.0);
        collisionGroup.visible = true;
        walkableGroup.visible = showWalkableEl.checked;
        rebuildHitFilterMenu();
        applyCollisionVisibility();
        setSelectedMesh(null);
        highlightObjectRow(null);
        lastHitPoint = null;

        const collisionFaces = countTriangles(collisionGroup);
        const walkableFaces = countTriangles(walkableGroup);
        const totalFaces = collisionFaces + walkableFaces;
        const failCount = cResult.failed.length + wResult.failed.length;

        fitCameraToRoot();
        setStatus(
            `loaded\ncollision files: ${collisionGroup.children.length}/${collisionEntries.length}, faces: ${collisionFaces}\nwalkable files: ${walkableGroup.children.length}/${walkableEntries.length}, faces: ${walkableFaces}\ntotal faces: ${totalFaces}\nfailed files: ${failCount}`
        );
    } catch (e) {
        setStatus(`load failed: ${e.message || e}`, true);
    } finally {
        loadBtn.disabled = false;
    }
}

showCollisionEl.addEventListener("change", () => {
    if (collisionGroup) {
        applyCollisionVisibility();
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

loadBtn.addEventListener("click", reload);
fitBtn.addEventListener("click", fitCameraToRoot);
exportEnabledBtn.addEventListener("click", exportEnabledList);
csmEnabledEl.addEventListener("change", updateDisplaySettings);
csmMaxFarEl.addEventListener("input", updateDisplaySettings);
csmIntensityEl.addEventListener("input", updateDisplaySettings);
csmShadowBiasEl.addEventListener("input", updateDisplaySettings);
csmNormalBiasEl.addEventListener("input", updateDisplaySettings);
csmShadowRadiusEl.addEventListener("input", updateDisplaySettings);
ssaoEnabledEl.addEventListener("change", updateDisplaySettings);
ssaoKernelEl.addEventListener("input", updateDisplaySettings);
ssaoMinDistEl.addEventListener("input", updateDisplaySettings);
ssaoMaxDistEl.addEventListener("input", updateDisplaySettings);
smaaEnabledEl.addEventListener("change", updateDisplaySettings);
toneMappingEnabledEl.addEventListener("change", updateDisplaySettings);
toneExposureEl.addEventListener("input", updateDisplaySettings);
outlineEnabledEl.addEventListener("change", updateDisplaySettings);
outlineStrengthEl.addEventListener("input", updateDisplaySettings);
outlineThicknessEl.addEventListener("input", updateDisplaySettings);
resetCsmBtn.addEventListener("click", resetCsmDefaults);
resetSsaoBtn.addEventListener("click", resetSsaoDefaults);
resetSmaaBtn.addEventListener("click", resetSmaaDefaults);
resetToneBtn.addEventListener("click", resetToneDefaults);
resetOutlineBtn.addEventListener("click", resetOutlineDefaults);
renderer.domElement.addEventListener("click", (event) => {
    if (suppressNextClick) {
        suppressNextClick = false;
        return;
    }
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
    const meta = getInstanceMetaFromTarget(first.object);
    if (meta) {
        setStatus(`picked: ${getDisplayName(src || "mesh")} | hitFilter=${meta.msbHitFilterId} (${meta.msbHitFilterType})`);
    } else {
        setStatus(`picked: ${getDisplayName(src || "mesh")}`);
    }
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
renderer.domElement.addEventListener("pointerdown", (event) => {
    pointerDown = true;
    pointerDownX = event.clientX;
    pointerDownY = event.clientY;
});
renderer.domElement.addEventListener("pointermove", (event) => {
    if (!pointerDown) return;
    const dx = event.clientX - pointerDownX;
    const dy = event.clientY - pointerDownY;
    if (dx * dx + dy * dy > 16) {
        suppressNextClick = true;
    }
});
renderer.domElement.addEventListener("pointerup", () => {
    pointerDown = false;
});
renderer.domElement.addEventListener("pointercancel", () => {
    pointerDown = false;
});

window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    csm.updateFrustums();
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);
    ssaoPass.setSize(window.innerWidth, window.innerHeight);
    outlinePass.setSize(window.innerWidth, window.innerHeight);
    smaaPass.setSize(window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());
});

function animate() {
    controls.update();
    csm.update();
    composer.render();
    requestAnimationFrame(animate);
}

animate();
updateDisplaySettings();
reload();
