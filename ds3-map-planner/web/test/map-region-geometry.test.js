import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createRegionOverlayObjects } from "../pages/regions/overlay/region-overlay-meshes.js";
import { createRegionMask } from "../pages/regions/runtime/region-stage5-mask.js";
import {
  activeRegions,
  addGapMarker,
  footprintForHeight,
  groupSplitsByLayer,
  occupancyBoundsFromTriangles,
  findUncoveredSamples,
  hasSelfIntersection,
  pointInPolygon,
  sceneToGame,
  summarizeUncoveredCoverage,
  validateRegions,
} from "../pages/regions/geometry/region-geometry.js";
const lower = {
  name: "lower",
  ymin: 0,
  ymax: 3,
  polygon_xz: [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
};
const upper = {
  name: "upper",
  ymin: 2,
  ymax: 5,
  polygon_xz: [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
};
test("point-in-polygon supports concave polygons and edges", () => {
  const p = [
    [0, 0],
    [4, 0],
    [4, 4],
    [2, 2],
    [0, 4],
  ];
  assert.equal(pointInPolygon([0, 2], p), true);
  assert.equal(pointInPolygon([2, 3], p), false);
});
test("invalid polygons are rejected", () => {
  assert.equal(
    hasSelfIntersection([
      [0, 0],
      [3, 3],
      [0, 3],
      [3, 0],
    ]),
    true,
  );
  assert.match(validateRegions([lower, { ...lower }]), /duplicated/);
});
test("active regions are ordered and coordinate conversion preserves world coordinates", () => {
  assert.deepEqual(
    activeRegions([lower, upper], [2, 2.5, 2]).map((r) => r.name),
    ["lower", "upper"],
  );
  assert.deepEqual(sceneToGame([1, 2, 3]), [1, 2, 3]);
});

test("stage5 mask stores region polygons in scene coordinates", () => {
  const mask = createRegionMask({
    ymin: 0,
    polygon_xz: [
      [0, 1],
      [2, 1],
      [0, 3],
    ],
  });
  mask.updateMatrixWorld(true);
  const position = mask.geometry.getAttribute("position");
  const worldPoints = Array.from({ length: position.count }, (_, index) =>
    new THREE.Vector3(
      position.getX(index),
      position.getY(index),
      position.getZ(index),
    ).applyMatrix4(mask.matrixWorld),
  );
  const worldZs = [...new Set(worldPoints.map((point) => point.z))].sort(
    (a, b) => a - b,
  );

  assert.ok(worldPoints.some((point) => point.x === 0));
  assert.deepEqual(worldZs, [1, 3]);
  mask.geometry.dispose();
  mask.material.dispose();
});

test("region overlay prism maps ymin and ymax to ascending scene Y", () => {
  const [mesh, edges] = createRegionOverlayObjects(
    {
      ymin: -2,
      ymax: 5,
      polygon_xz: [
        [1, 2],
        [3, 2],
        [3, 4],
        [1, 4],
      ],
    },
    0xffffff,
  );

  mesh.geometry.computeBoundingBox();
  assert.equal(mesh.geometry.boundingBox.min.y, -2);
  assert.equal(mesh.geometry.boundingBox.max.y, 5);
  assert.equal(mesh.geometry.boundingBox.min.z, 2);
  assert.equal(mesh.geometry.boundingBox.max.z, 4);

  mesh.geometry.dispose();
  mesh.material.dispose();
  edges.geometry.dispose();
  edges.material.dispose();
});

test("coverage samples use the full prism, not only XZ", () => {
  const triangle = [
    [
      [1, 1, 1],
      [2, 1, 1],
      [1, 1, 2],
    ],
  ];
  assert.equal(findUncoveredSamples([lower], triangle).length, 0);
  assert.ok(
    findUncoveredSamples([{ ...lower, ymax: 0.5 }], triangle).length > 0,
  );
});

test("coverage summary reports area ratio and largest gap", () => {
  const triangles = [
    [
      [0, 1, 0],
      [2, 1, 0],
      [0, 1, 2],
    ],
  ];
  const uncovered = findUncoveredSamples([{ ...lower, ymax: 0.5 }], triangles);
  const summary = summarizeUncoveredCoverage(uncovered, triangles, 1);
  assert.equal(summary.targetArea, 2);
  assert.ok(summary.uncoveredArea > 0);
  assert.ok(summary.uncoveredRatio > 0);
  assert.ok(summary.largestComponentArea > 0);
  assert.deepEqual(summary.representative, uncovered[0]);
});

test("gap markers are de-duplicated in world-space cells", () => {
  const markers = new Map();
  assert.equal(addGapMarker(markers, [0.1, 0.1, 0.1]), true);
  assert.equal(addGapMarker(markers, [0.4, 0.2, 0.3]), false);
  assert.equal(markers.size, 1);
});

test("automatic layers retain whole splits and separate stacked floors", () => {
  const triangle = (y) => [
    [
      [0, y, 0],
      [2, y, 0],
      [0, y, 2],
    ],
  ];
  const layers = groupSplitsByLayer([
    { key: "lower", triangles: triangle(0) },
    { key: "upper", triangles: triangle(5) },
    { key: "peer", triangles: triangle(0.1) },
  ]);
  assert.equal(layers.length, 2);
  assert.equal(layers[0].members.length, 2);
  assert.equal(layers[1].members[0].key, "upper");
});

test("lower camera height produces a smaller footprint", () => {
  const config = { render_width: 16, render_height: 9, fov_y_rad: Math.PI / 3 };
  assert.ok(
    footprintForHeight(config, 2).width < footprintForHeight(config, 4).width,
  );
});

test("occupancy contour retains a concave grid outline instead of a bounding box", () => {
  const triangles = [
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    [
      [1, 0, 0],
      [2, 0, 0],
      [1, 0, 1],
    ],
    [
      [2, 0, 0],
      [2, 0, 1],
      [1, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 1],
      [0, 0, 2],
    ],
    [
      [1, 0, 1],
      [1, 0, 2],
      [0, 0, 2],
    ],
  ];
  const [polygon] = occupancyBoundsFromTriangles(triangles, 1);
  assert.ok(polygon.length > 4);
});
