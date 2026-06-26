import test from "node:test";
import assert from "node:assert/strict";
import { filterTrianglesForRegion } from "../pages/regions/geometry/region-geometry.js";
import { replaceRegionPlan } from "../pages/regions/planning/region-plan-controller.js";
import { createMergedCollisionMesh } from "../pages/regions/planning/region-collision-bvh.js";
import { createCoverageStats } from "../pages/regions/planning/region-coverage-stats.js";
import {
  createRegionShotPlan,
  flattenTriangles,
} from "../pages/regions/planning/region-shot-plan-system.js";
import * as THREE from "three";

const region = {
  name: "Hall",
  ymin: 0,
  ymax: 3,
  polygon_xz: [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
};

test("filterTrianglesForRegion keeps only triangles touching the region prism", () => {
  const inside = [
    [1, 1, 1],
    [2, 1, 1],
    [1, 1, 2],
  ];
  const outside = [
    [10, 1, 10],
    [11, 1, 10],
    [10, 1, 11],
  ];

  assert.deepEqual(filterTrianglesForRegion([inside, outside], region), [
    inside,
  ]);
});

test("replaceRegionPlan updates by region name without migrating other plans", () => {
  const currentPlans = [
    { region_name: "Old Name", plan: { points: [1] } },
    { region_name: "Hall", plan: { points: [2] } },
  ];
  const next = { region_name: "Hall", plan: { points: [3] } };

  assert.deepEqual(replaceRegionPlan(currentPlans, next), [
    { region_name: "Old Name", plan: { points: [1] } },
    next,
  ]);
});

test("region shot plan result preserves worker metadata and coverage stats", () => {
  const triangle = [
    [0, 0, 0],
    [2, 0, 0],
    [0, 0, 2],
  ];
  const config = {
    render_width: 100,
    render_height: 100,
    fov_y_rad: Math.PI / 2,
  };
  const workerResult = {
    coord_space: "world",
    version: 1,
    config,
    points: [
      { id: 0, x: 0.5, y: 2, y_ref: 0, z: 0.5 },
      { id: 1, x: 2, y: 2, y_ref: 0, z: 2 },
    ],
  };
  const adjustment = {
    points: [{ id: 0, x: 0.5, y: 2, y_ref: 0, z: 0.5 }],
    lowered: 1,
    rejected: 1,
    replenished_count: 0,
  };

  const plan = createRegionShotPlan({
    region,
    config,
    triangles: [triangle],
    workerResult,
    adjustment,
  });

  assert.equal(plan.region_name, "Hall");
  assert.deepEqual(plan.plan.points, adjustment.points);
  assert.equal(plan.coverage.target_area, 2);
  assert.equal(plan.coverage.candidate_count, 2);
  assert.equal(plan.coverage.lowered_count, 1);
  assert.equal(plan.coverage.rejected_count, 1);
  assert.equal(plan.coverage.final_count, 1);
});

test("coverage stats and triangle flattening are stable pure helpers", () => {
  const stats = createCoverageStats({
    triangles: [
      [
        [0, 0, 0],
        [2, 0, 0],
        [0, 0, 2],
      ],
    ],
    workerResult: {
      config: {
        render_width: 100,
        render_height: 100,
        fov_y_rad: Math.PI / 2,
      },
      points: [{}, {}, {}],
    },
    adjustment: {
      points: [{ x: 0.5, y: 2, y_ref: 0, z: 0.5 }],
      lowered: 1,
      rejected: 2,
      replenished_count: 1,
    },
  });

  assert.equal(stats.target_area, 2);
  assert.equal(stats.candidate_count, 3);
  assert.equal(stats.lowered_count, 1);
  assert.equal(stats.rejected_count, 2);
  assert.equal(stats.replenished_count, 1);
  assert.equal(stats.final_count, 1);
  assert.ok(stats.covered_area > 0);

  assert.deepEqual(Array.from(flattenTriangles([[[1, 2, 3]]])), [1, 2, 3]);
});

test("merged collision mesh bakes child transforms for BVH raycasts", () => {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  mesh.position.set(0, 5, 0);
  group.add(mesh);

  const merged = createMergedCollisionMesh(group);
  assert.ok(merged.geometry.boundsTree);
  merged.geometry.computeBoundingBox();
  assert.equal(merged.geometry.boundingBox.min.y, 4);
  assert.equal(merged.geometry.boundingBox.max.y, 6);

  merged.geometry.disposeBoundsTree();
  merged.geometry.dispose();
  merged.material.dispose();
});
