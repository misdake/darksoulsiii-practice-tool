import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FilterAssetLoader } from "../pages/filter/assets/filter-asset-loader.js";

test("collision loading preserves every mesh in a multi-object OBJ", async () => {
  const loader = Object.create(FilterAssetLoader.prototype);
  loader.pool = {
    async parse() {
      return {
        meshes: [
          {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
          },
          {
            positions: [2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 0],
            indices: [0, 1, 2, 0, 2, 3],
          },
        ],
      };
    },
  };
  loader.makeMaterial = () => new THREE.MeshBasicMaterial();

  const group = await loader.loadCollision({ path: "multi-object.obj" });

  assert.equal(group.children.length, 2);
  assert.equal(group.userData.triangleCount, 3);
  assert.deepEqual(
    group.children.map((mesh) => mesh.geometry.index.count),
    [3, 6],
  );

  group.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry.disposeBoundsTree?.();
    object.geometry.dispose();
    object.material.dispose();
  });
});
