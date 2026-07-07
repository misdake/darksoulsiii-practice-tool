import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { normalizeStaticMeshData } from "../shared/map-runtime.js";
import {
  disposeRegionAssetTargets,
  RegionAssetLoader,
} from "../pages/regions/assets/region-asset-loader.js";
import { RegionMapLoadController } from "../pages/regions/map/region-map-load-controller.js";
import { RegionPlanController } from "../pages/regions/planning/region-plan-controller.js";
import { RegionFreeCamera } from "../pages/regions/viewport/region-free-camera.js";
import { applyRegionBroadPhase } from "../pages/regions/runtime/region-clipping.js";
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
  const mapScene = new THREE.Scene();
  mapScene.add(navGroup, collisionGroup);

  const renderer = new RegionClippedMapRenderer({
    scene: mapScene,
  });
  const emptyPlayerScene = renderer.playerScene;
  renderer.setPlayerMesh(null);
  assert.equal(renderer.playerScene, emptyPlayerScene);
  renderer.setPlayerMesh(source);
  assert.equal(
    renderer.playerScene.children.filter((object) => object.isLight).length,
    2,
  );
  assert.equal(renderer.scene, mapScene);
  assert.equal(renderer.scene.children[0], navGroup);
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

test("Clipped map broad phase operates directly on its dedicated scene", () => {
  const scene = new THREE.Scene();
  const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  far.position.set(20, 0, 20);
  scene.add(near, far);

  applyRegionBroadPhase(scene, {
    ymin: -2,
    ymax: 2,
    polygon_xz: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
  });
  assert.equal(near.visible, true);
  assert.equal(far.visible, false);
  const cachedBounds = near.userData.worldBounds;
  near.visible = true;
  far.visible = true;
  applyRegionBroadPhase(scene, {
    ymin: -2,
    ymax: 2,
    polygon_xz: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
  });
  assert.equal(near.userData.worldBounds, cachedBounds);

  near.geometry.dispose();
  far.geometry.dispose();
  near.material.dispose();
  far.material.dispose();
});

test("map assets install atomically and dispose shared geometry once", async () => {
  const normalized = normalizeStaticMeshData({
    positions: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    indices: [0, 1, 2],
  });
  assert.deepEqual(Array.from(normalized.positions), [
    0, 1, -2, 3, 4, -5, 6, 7, -8,
  ]);
  assert.deepEqual(Array.from(normalized.indices), [0, 2, 1]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const values = {
      "/api/maps/test/content": {
        navmesh_manifest: { navmeshes: [{ path: "nav.obj" }] },
      },
      "/api/maps/test/stage1-collision-filter": {},
      "/api/maps/test/stage2-nav-filter": {
        nav_enabled_paths: ["nav.obj"],
      },
      "/api/maps/test/stage3-mark-nav": {
        selected_nav_segments: [{ nav_name: "nav.obj", segment_index: 0 }],
      },
    };
    return {
      ok: true,
      status: 200,
      json: async () => values[url],
    };
  };
  let parseCount = 0;
  const loader = new RegionAssetLoader({
    async parse() {
      parseCount += 1;
      return {
        meshes: [{
          positions: [0, 0, 0, 1, 1, 0, 0, 2, 1],
          indices: [0, 1, 2],
        }],
      };
    },
  });
  const liveTargets = Array.from({ length: 2 }, () => ({
    navmesh: new THREE.Group(),
    collision: new THREE.Group(),
  }));
  const oldGeometry = new THREE.BoxGeometry(1, 1, 1);
  let oldDisposeCount = 0;
  oldGeometry.addEventListener("dispose", () => {
    oldDisposeCount += 1;
  });
  for (const target of liveTargets) {
    target.navmesh.add(
      new THREE.Mesh(oldGeometry, new THREE.MeshBasicMaterial()),
    );
  }
  try {
    const bundle = await loader.load("test", { targetCount: 2 });
    assert.equal(liveTargets[0].navmesh.children.length, 1);
    bundle.install(liveTargets);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(oldDisposeCount, 1);
  const rightMesh = liveTargets[0].navmesh.children[0];
  const leftMesh = liveTargets[1].navmesh.children[0];
  assert.equal(parseCount, 1);
  assert.notEqual(rightMesh, leftMesh);
  assert.equal(rightMesh.geometry, leftMesh.geometry);
  assert.notEqual(rightMesh.material, leftMesh.material);

  const shader = {
    uniforms: {},
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <color_fragment>",
  };
  rightMesh.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /fract\(rawRegionT \* 2\.0/);
  assert.equal(shader.uniforms.regionHeightBandPhase, undefined);

  let disposeCount = 0;
  rightMesh.geometry.addEventListener("dispose", () => {
    disposeCount += 1;
  });
  disposeRegionAssetTargets(liveTargets);
  assert.equal(disposeCount, 1);
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
  let current = true;
  let disposed = false;
  const controller = new RegionMapLoadController({
    assetLoader: {
      async load() {
        current = false;
        return {
          dispose() {
            disposed = true;
          },
        };
      },
    },
    navGroup: new THREE.Group(),
    collisionGroup: new THREE.Group(),
    leftNavGroup: new THREE.Group(),
    leftCollisionGroup: new THREE.Group(),
    sceneController: { rebuild() {} },
    state,
  });

  try {
    const loaded = await controller.load("m00_00_00_00", {
      isCurrent: () => current,
    });

    assert.equal(loaded, null);
    assert.equal(state.loaded, false);
    assert.equal(disposed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RegionPlanController drops stale and cancelled calculation results", async () => {
  const group = {
    uuid: "11111111-1111-4111-8111-111111111111",
    name: "Hall",
    last_updated: "2026-06-30T00:00:00.000Z",
    prisms: [{ ymin: -1, ymax: 1, polygon_xz: [[-1, -1], [2, -1], [2, 2], [-1, 2]] }],
  };
  const state = {
    mapId: "map-a",
    planningTargetKey: `region_group:${group.uuid}`,
    regionGroups: [group],
    plans: [],
  };
  const staleController = new RegionPlanController({
    planSystem: {
      async calculate() {
        state.mapId = "map-b";
        return { kind: "region_group", region_group_uuid: group.uuid, plan: { points: [] } };
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

  const result = await staleController.calculate({});

  assert.equal(result, state.plans);
  assert.deepEqual(state.plans, []);

  let resolveCalculation;
  const cancelState = {
    mapId: "map-a",
    planningTargetKey: `region_group:${group.uuid}`,
    regionGroups: [group],
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

  const calculation = cancelController.calculate({});
  cancelController.cancel("test cancellation", false);
  resolveCalculation({ kind: "region_group", region_group_uuid: group.uuid, plan: { points: [{}] } });

  assert.equal(await calculation, cancelState.plans);
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
