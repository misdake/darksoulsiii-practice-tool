import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  buildAutoRegions,
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

test("createRegionFromMesh uses world bounds and stores right-handed polygon", () => {
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
});

test("buildAutoRegions keeps stacked navmesh layers as separate regions", () => {
  const group = new THREE.Group();
  group.add(createTriangleMesh(0, 0));
  group.add(createTriangleMesh(0, 5));

  const regions = buildAutoRegions(group);

  assert.equal(regions.length, 2);
  assert.deepEqual(
    regions.map((region) => region.ymin),
    [-0.5, 4.5],
  );
});

test("generated regions add height padding above the navmesh ceiling", () => {
  const geometry = new THREE.BoxGeometry(2, 4, 2);
  geometry.translate(0, 10, 0);
  const mesh = new THREE.Mesh(geometry);

  assert.equal(createRegionFromMesh(mesh, 0).ymin, 7.5);
  assert.equal(createRegionFromMesh(mesh, 0).ymax, 15);
});

test("multiple selected meshes generate one union region", () => {
  const first = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  first.position.set(0, 1, 0);
  const second = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2));
  second.position.set(10, 2, 5);

  assert.deepEqual(createRegionFromMeshes([first, second], 0), {
    name: "Region 1",
    ymin: -0.5,
    ymax: 7,
    polygon_xz: [
      [-1, -1],
      [11, -1],
      [11, 6],
      [-1, 6],
    ],
  });
});

function createTriangleMesh(x, y) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        x,
        y,
        0,
        x + 2,
        y,
        0,
        x,
        y,
        -2,
      ],
      3,
    ),
  );

  const mesh = new THREE.Mesh(geometry);
  mesh.userData = { navPath: "nav.obj", segmentIndex: y };
  return mesh;
}
