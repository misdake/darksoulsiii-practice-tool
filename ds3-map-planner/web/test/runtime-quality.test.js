import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { normalizeStaticMeshData } from "../shared/map-runtime.js";
import { RegionMapLoadController } from "../pages/regions/map/region-map-load-controller.js";
import { RegionPlanController } from "../pages/regions/planning/region-plan-controller.js";
import { RegionFreeCamera } from "../pages/regions/viewport/region-free-camera.js";
import {
  applyRegionBroadPhase,
  cloneClippedSourceScene,
  disposeClippedScene,
} from "../pages/regions/runtime/region-clipped-map-scene.js";
import { RegionClippedMapRenderer } from "../pages/regions/runtime/region-clipped-map-renderer.js";
import { shouldRecordTestMissing } from "../pages/regions/runtime/region-test-state.js";
import { saveStageData } from "../shared/map-api.js";

test("regional viewport framing and Test player visuals stay synchronized", () => {
  const source = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.3, 0.96),
    new THREE.MeshBasicMaterial(),
  );
  source.visible = true;
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.72),
    new THREE.MeshBasicMaterial(),
  );
  arrow.userData.kind = "camera-direction";
  source.add(arrow);

  const navGroup = new THREE.Group();
  const collisionGroup = new THREE.Group();
  const nav = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  nav.userData.kind = "navmesh-split";
  const collision = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  navGroup.add(nav);
  collisionGroup.add(collision);

  const renderer = new RegionClippedMapRenderer({
    includeNavmesh: true,
    manageCollisionDisplay: true,
  });
  const emptyPlayerScene = renderer.playerScene;
  renderer.setPlayerMesh(null);
  assert.equal(renderer.playerScene, emptyPlayerScene);
  renderer.rebuild(navGroup, collisionGroup);
  renderer.setCollisionDisplay(false, 0.4);
  renderer.setNavmeshOpacity(0.6);
  renderer.setPlayerMesh(source);
  assert.equal(
    renderer.playerScene.children.filter((object) => object.isLight).length,
    2,
  );
  assert.equal(
    renderer.scene.children.filter((object) => object.userData.kind).length,
    2,
  );
  const collisionClone = renderer.scene.children.find(
    (object) => object.userData.kind === "collision",
  );
  assert.equal(collisionClone.visible, false);
  assert.equal(collisionClone.children[0].material.opacity, 0.4);
  assert.equal(collisionClone.children[0].material.transparent, true);
  const navClone = renderer.scene.children.find(
    (object) => object.userData.kind === "navmesh",
  );
  assert.equal(navClone.children[0].material.opacity, 0.6);
  assert.equal(renderer.playerMesh.children.length, 1);
  assert.equal(renderer.playerMesh.children[0].material.transparent, false);

  arrow.position.set(2, 3, 4);
  source.material.color.setHex(0xfb923c);
  renderer.setPlayerMesh(source);
  assert.deepEqual(renderer.playerMesh.children[0].position.toArray(), [2, 3, 4]);
  assert.equal(renderer.playerMesh.material.color.getHex(), 0xfb923c);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.userData.target = new THREE.Vector3();
  new RegionFreeCamera(camera).focusBounds(new THREE.Vector3(), 4000);
  assert.ok(camera.far > camera.position.length());

  renderer.dispose();
  source.geometry.dispose();
  source.material.dispose();
  arrow.geometry.dispose();
  arrow.material.dispose();
  nav.geometry.dispose();
  nav.material.dispose();
  collision.geometry.dispose();
  collision.material.dispose();
});

test("stage saves accept an empty successful response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 204, url: "/stage" });
  try {
    await assert.doesNotReject(
      saveStageData("m30_00_00_00", "stage4-map-regions", { regions: [] }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Clipped map broad phase hides collision outside the active region prism", () => {
  const source = new THREE.Group();
  const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  far.position.set(20, 0, 20);
  source.add(near, far);
  const scene = cloneClippedSourceScene(null, source);

  applyRegionBroadPhase(scene, {
    ymin: -2,
    ymax: 2,
    polygon_xz: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
  });
  const clones = [];
  scene.traverse((object) => {
    if (object.isMesh) clones.push(object);
  });
  assert.equal(clones[0].visible, true);
  assert.equal(clones[1].visible, false);

  disposeClippedScene(scene);
  near.geometry.dispose();
  far.geometry.dispose();
});

test("map assets normalize static geometry to right-handed coordinates", () => {
  const normalized = normalizeStaticMeshData({
    positions: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    indices: [0, 1, 2],
  });
  assert.deepEqual(Array.from(normalized.positions), [
    0, 1, -2, 3, 4, -5, 6, 7, -8,
  ]);
  assert.deepEqual(Array.from(normalized.indices), [0, 2, 1]);
});

test("RegionMapLoadController ignores stale loads before mutating state", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 404,
    text: async () => "",
    json: async () => ({}),
  });
  const state = {
    loaded: false,
    load() {
      this.loaded = true;
    },
  };
  const controller = new RegionMapLoadController({
    assetLoader: {
      async load() {
        throw new Error("asset loader should not run for stale loads");
      },
    },
    navGroup: new THREE.Group(),
    collisionGroup: new THREE.Group(),
    sceneController: { rebuild() {} },
    state,
  });

  try {
    const loaded = await controller.load("m00_00_00_00", {
      isCurrent: () => false,
    });

    assert.equal(loaded, null);
    assert.equal(state.loaded, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RegionPlanController drops stale and cancelled calculation results", async () => {
  const state = {
    mapId: "map-a",
    regions: [{ name: "Hall" }],
    plans: [],
  };
  const staleController = new RegionPlanController({
    planSystem: {
      async calculate() {
        state.mapId = "map-b";
        return { region_name: "Hall", plan: { points: [] } };
      },
    },
    state,
    navGroup: {
      children: [
        {
          geometry: triangleGeometry(),
        },
      ],
    },
    setStatus() {},
    setDisabled() {},
    sync() {
      throw new Error("stale plan should not sync");
    },
  });

  const currentPlans = [];
  const result = await staleController.calculate(
    {
      name: "Hall",
      ymin: -1,
      ymax: 1,
      polygon_xz: [
        [-1, -1],
        [2, -1],
        [2, 2],
        [-1, 2],
      ],
    },
    currentPlans,
  );

  assert.equal(result, currentPlans);
  assert.deepEqual(state.plans, []);

  let resolveCalculation;
  const cancelState = {
    mapId: "map-a",
    regions: [{ name: "Hall" }],
    plans: [],
  };
  const cancelController = new RegionPlanController({
    planSystem: {
      calculate() {
        return new Promise((resolve) => {
          resolveCalculation = resolve;
        });
      },
      cancel() {},
    },
    state: cancelState,
    navGroup: { children: [{ geometry: triangleGeometry() }] },
    setStatus() {},
    setPlanning() {},
    setProgress() {},
    sync() {
      throw new Error("cancelled plan should not sync");
    },
  });

  const cancelPlans = [];
  const calculation = cancelController.calculate(
    {
      name: "Hall",
      ymin: -1,
      ymax: 1,
      polygon_xz: [[-1, -1], [2, -1], [2, 2], [-1, 2]],
    },
    cancelPlans,
    {},
  );
  cancelController.cancel("test cancellation", false);
  resolveCalculation({ region_name: "Hall", plan: { points: [{}] } });

  assert.equal(await calculation, cancelPlans);
  assert.deepEqual(cancelState.plans, []);
});

test("Test missing markers require the enabled third-person leak state", () => {
  assert.equal(
    shouldRecordTestMissing({
      stage: 4,
      stage4Mode: "test",
      enabled: true,
      mode: "thirdPerson",
      playerReady: true,
      paused: false,
      activeRegions: [],
    }),
    true,
  );
  assert.equal(
    shouldRecordTestMissing({
      stage: 4,
      stage4Mode: "test",
      enabled: false,
      mode: "thirdPerson",
      playerReady: true,
      paused: false,
      activeRegions: [],
    }),
    false,
  );
  assert.equal(
    shouldRecordTestMissing({
      stage: 4,
      stage4Mode: "test",
      enabled: true,
      mode: "free",
      playerReady: true,
      paused: false,
      activeRegions: [],
    }),
    false,
  );
  assert.equal(
    shouldRecordTestMissing({
      stage: 4,
      stage4Mode: "test",
      enabled: true,
      mode: "thirdPerson",
      playerReady: true,
      paused: true,
      activeRegions: [],
    }),
    false,
  );
  assert.equal(
    shouldRecordTestMissing({
      stage: 4,
      stage4Mode: "test",
      enabled: true,
      mode: "thirdPerson",
      playerReady: true,
      paused: false,
      activeRegions: [{ name: "inside" }],
    }),
    false,
  );
});

function triangleGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, -1], 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  return geometry;
}
