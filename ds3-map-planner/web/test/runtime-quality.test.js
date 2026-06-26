import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createObjParser,
  normalizeStaticMeshData,
} from "../shared/map-runtime.js";
import { RegionMapLoadController } from "../pages/regions/map/region-map-load-controller.js";
import { RegionPlanController } from "../pages/regions/planning/region-plan-controller.js";
import { disposeStage5Scene } from "../pages/regions/runtime/region-stage5-scene.js";
import { shouldRecordStage5Missing } from "../pages/regions/runtime/region-stage5-state.js";

test("disposeStage5Scene can dispose transient mask geometry", () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshBasicMaterial();
  let geometryDisposed = false;
  let materialDisposed = false;
  geometry.dispose = () => {
    geometryDisposed = true;
  };
  material.dispose = () => {
    materialDisposed = true;
  };
  scene.add(new THREE.Mesh(geometry, material));

  disposeStage5Scene(scene, { disposeGeometry: true });

  assert.equal(geometryDisposed, true);
  assert.equal(materialDisposed, true);
  assert.equal(scene.children.length, 0);
});

test("createObjParser rejects pending parses on dispose", async () => {
  const OriginalWorker = globalThis.Worker;
  class WorkerStub {
    addEventListener() {}
    postMessage() {}
    terminate() {}
  }
  globalThis.Worker = WorkerStub;
  try {
    const parser = createObjParser("stub-worker.js");
    const pending = parser.parse("map.obj");
    parser.dispose();
    await assert.rejects(pending, /disposed/);
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});

test("static mesh data is normalized to right-handed coordinates at load boundary", () => {
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

test("RegionPlanController drops stale calculation results", async () => {
  const state = {
    mapId: "map-a",
    regions: [{ name: "Hall" }],
    plans: [],
  };
  const controller = new RegionPlanController({
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
  const result = await controller.calculate(
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
