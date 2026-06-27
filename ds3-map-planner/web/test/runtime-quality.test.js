import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { normalizeStaticMeshData } from "../shared/map-runtime.js";
import { RegionMapLoadController } from "../pages/regions/map/region-map-load-controller.js";
import { RegionPlanController } from "../pages/regions/planning/region-plan-controller.js";
import {
  applyRegionBroadPhase,
  cloneStage5SourceScene,
  disposeStage5Scene,
} from "../pages/regions/runtime/region-stage5-scene.js";
import { RegionStage5MapRenderer } from "../pages/regions/runtime/region-clipped-map-renderer.js";
import { shouldRecordStage5Missing } from "../pages/regions/runtime/region-stage5-state.js";
import { saveStageData } from "../shared/map-api.js";

test("Stage5 left player visual clones and updates the camera direction arrow", () => {
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

  const renderer = new RegionStage5MapRenderer();
  renderer.setPlayerMesh(source);
  assert.equal(renderer.playerMesh.children.length, 1);
  assert.equal(renderer.playerMesh.children[0].material.transparent, false);

  arrow.position.set(2, 3, 4);
  renderer.setPlayerMesh(source);
  assert.deepEqual(renderer.playerMesh.children[0].position.toArray(), [2, 3, 4]);
  renderer.dispose();
  source.geometry.dispose();
  source.material.dispose();
  arrow.geometry.dispose();
  arrow.material.dispose();
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

test("Stage5 broad phase hides collision outside the active region prism", () => {
  const source = new THREE.Group();
  const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  far.position.set(20, 0, 20);
  source.add(near, far);
  const scene = cloneStage5SourceScene(null, source);

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

  disposeStage5Scene(scene);
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

test("Stage5 missing markers record only for active third-person player leaks", () => {
  assert.equal(
    shouldRecordStage5Missing({
      stage: 5,
      mode: "thirdPerson",
      playerReady: true,
      paused: false,
      activeRegions: [],
    }),
    true,
  );
  assert.equal(
    shouldRecordStage5Missing({
      stage: 5,
      mode: "free",
      playerReady: true,
      paused: false,
      activeRegions: [],
    }),
    false,
  );
  assert.equal(
    shouldRecordStage5Missing({
      stage: 5,
      mode: "thirdPerson",
      playerReady: true,
      paused: true,
      activeRegions: [],
    }),
    false,
  );
  assert.equal(
    shouldRecordStage5Missing({
      stage: 5,
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
