import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createRegionFromMesh,
  createRegionFromMeshes,
  trianglesFromMesh,
} from "../pages/regions/assets/region-navmesh-utils.js";

test("trianglesFromMesh returns right-handed world-space triangles", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 1, 2, 3, 4, 5, 6, 7, 8], 3),
  );
  const mesh = new THREE.Mesh(geometry);

  assert.deepEqual(trianglesFromMesh(mesh), [
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
  ]);
});

test("generated regions use world height bounds, padding and a union XZ OBB", () => {
  const geometry = new THREE.BoxGeometry(4, 2, 6);
  geometry.translate(10, 5, -20);
  const mesh = new THREE.Mesh(geometry);

  assert.deepEqual(createRegionFromMesh(mesh, 2), {
    name: "Region 3",
    ymin: 3.5,
    ymax: 9,
    polygon_xz: [
      [8, -23],
      [12, -23],
      [12, -17],
      [8, -17],
    ],
  });

  const first = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  first.position.set(0, 1, 0);
  const second = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2));
  second.position.set(10, 2, 5);

  const combined = createRegionFromMeshes([first, second], 0);
  assert.equal(combined.name, "Region 1");
  assert.equal(combined.ymin, -0.5);
  assert.equal(combined.ymax, 7);
  assert.deepEqual(combined.polygon_xz.map(([x, z]) => [round(x), round(z)]), [
    [-1.8, 0.6],
    [-0.6, -1.8],
    [11.8, 4.4],
    [10.6, 6.8],
  ]);
  assert.ok(polygonArea(combined.polygon_xz) < 12 * 7);
});

function polygonArea(points) {
  return Math.abs(points.reduce((sum, [x, z], index) => {
    const [nextX, nextZ] = points[(index + 1) % points.length];
    return sum + x * nextZ - nextX * z;
  }, 0)) / 2;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
