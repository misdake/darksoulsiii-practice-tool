import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  filterTrianglesForRegion,
  triangleAreaXZ,
} from "../pages/regions/geometry/region-geometry.js";
import { regionContainsGamePoint } from "../pages/regions/geometry/region-validation.js";
import { createMergedCollisionMesh } from "../pages/regions/planning/region-collision-bvh.js";
import { createCoverageStats } from "../pages/regions/planning/region-coverage-stats.js";
import {
  RegionShotPlanSystem,
  connectedTargetComponents,
  createRegionShotPlan,
  flattenTriangles,
  normalizeRegionShotConfig,
} from "../pages/regions/planning/region-shot-plan-system.js";
import { calculateRegionShotCandidates } from "../region-shot-plan-worker.js";

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

const config = normalizeRegionShotConfig({
  render_width: 100,
  render_height: 100,
  fov_y_rad: Math.PI / 2,
  base_ratio_px_per_wu: 50,
  density_multiplier: 1,
  overlap_ratio: 0,
  y_lift: 0,
});

test("region prism clipping handles crossing, outside, concave and Y boundaries", () => {
  const crossing = [
    [-1, 1, 2],
    [5, 1, 2],
    [2, 1, 5],
  ];
  const outside = [
    [10, 1, 10],
    [11, 1, 10],
    [10, 1, 11],
  ];
  const clipped = filterTrianglesForRegion([crossing, outside], region);

  assert.ok(clipped.length > 0);
  assert.ok(clipped.flat().every((point) => regionContainsGamePoint(region, point)));
  assert.equal(clipped.reduce((sum, triangle) => sum + triangleAreaXZ(...triangle), 0), 7);

  const concave = {
    name: "L",
    ymin: 0,
    ymax: 3,
    polygon_xz: [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]],
  };
  const spanning = [[-1, -1, -1], [6, 4, -1], [-1, 4, 6]];
  const concaveClipped = filterTrianglesForRegion([spanning], concave);

  assert.ok(concaveClipped.length > 0);
  assert.ok(
    concaveClipped
      .flat()
      .every((point) => regionContainsGamePoint(concave, point)),
  );
  assert.ok(
    concaveClipped
      .flat()
      .every((point) => point[1] >= 0 && point[1] <= 3),
  );
});

test("worker preserves height layers and normalizes planning config", () => {
  const triangles = [
    [[0, 0, 0], [2, 0, 0], [0, 0, 2]],
    [[0, 2, 0], [2, 2, 0], [0, 2, 2]],
  ];
  const packed = flattenTriangles(triangles);
  const result = calculateRegionShotCandidates(packed.buffer, config);

  assert.ok(new Set(result.target_cells.map((cell) => cell.layer)).size >= 2);
  assert.ok(new Set(result.points.map((point) => point.layer)).size >= 2);
  assert.ok(result.target_cells.every((cell) => cell.x >= 0 && cell.z >= 0));

  const normalized = normalizeRegionShotConfig({
    render_width: 32,
    render_height: 20000,
    overlap_ratio: 2,
    wait_load_ms: 250,
  });
  assert.equal(normalized.render_width, 64);
  assert.equal(normalized.render_height, 16384);
  assert.equal(normalized.overlap_ratio, 0.9);
  assert.equal(normalized.wait_load_ms, 250);
  assert.equal(normalized.density_multiplier, 1);
});

test("worker target cells do not double-count overlapping group geometry", () => {
  const triangle = [[0, 0, 0], [2, 0, 0], [0, 0, 2]];
  const single = calculateRegionShotCandidates(flattenTriangles([triangle]).buffer, config);
  const duplicate = calculateRegionShotCandidates(flattenTriangles([triangle, triangle]).buffer, config);
  const area = (result) => result.target_cells.reduce((sum, cell) => sum + cell.area, 0);
  assert.equal(area(duplicate), area(single));
  assert.equal(duplicate.target_cells.length, single.target_cells.length);
});

test("planner classifies rejects and keeps uncovered components local", () => {
  const system = new RegionShotPlanSystem({ getCollisionTargets: () => [] });
  const candidate = { x: 0, y_ref: 0, y: 2, z: 0, layer: 0 };
  const cells = [{ key: "0:0:0", x: 0, y_ref: 0, z: 0, area: 1 }];

  system.findCeilingHit = () => ({ point: { y: 0.1 } });
  assert.equal(system.evaluateCandidate(candidate, cells, config).reason, "clearance");

  system.findCeilingHit = () => null;
  system.sampleCanSeeCamera = () => false;
  assert.equal(system.evaluateCandidate(candidate, cells, config).reason, "occlusion");
  system.dispose();

  const disconnectedCells = [
    { key: "0:0:0", ix: 0, iz: 0, layer: 0, y_ref: 0, area: 1 },
    { key: "1:0:0", ix: 1, iz: 0, layer: 0, y_ref: 0, area: 1 },
    { key: "8:0:0", ix: 8, iz: 0, layer: 0, y_ref: 0, area: 1 },
  ];
  const components = connectedTargetComponents(disconnectedCells);
  assert.deepEqual(components.map((component) => component.length), [2, 1]);
});

test("coverage stats and saved plans preserve the final planning result", () => {
  const targetCells = [
    { key: "a", area: 2 },
    { key: "b", area: 3 },
    { key: "c", area: 5 },
  ];
  const stats = createCoverageStats({
    targetCells,
    workerResult: { points: [{}, {}] },
    adjustment: {
      points: [{}],
      covered_cell_keys: ["a"],
      uncoverable_cell_keys: ["b"],
      remaining_cell_keys: ["c"],
      attempted: 4,
      lowered: 1,
      replenished_count: 1,
      rejected_by_reason: { clearance: 1, occlusion: 1, no_coverage: 1 },
    },
  });

  assert.equal(stats.target_area, 10);
  assert.equal(stats.covered_area, 2);
  assert.equal(stats.uncoverable_area, 3);
  assert.equal(stats.remaining_uncovered_area, 5);
  assert.equal(stats.coverage_ratio, 0.2);
  assert.equal(stats.rejected_count, 3);

  const workerResult = {
    coord_space: "world",
    version: 2,
    config,
    points: [{}, {}],
    target_cells: [{ key: "a", area: 2 }],
    local_candidates: [],
  };
  const adjustment = {
    points: [{ x: 0.5, y: 2, y_ref: 0, z: 0.5, lowered: true }],
    target_cells: workerResult.target_cells,
    covered_cell_keys: ["a"],
    uncoverable_cell_keys: [],
    remaining_cell_keys: [],
    attempted: 2,
    lowered: 1,
    replenished_count: 0,
    rejected_by_reason: { clearance: 1, occlusion: 0, no_coverage: 0 },
  };
  const target = {
    kind: "region_group",
    group: {
      uuid: "11111111-1111-4111-8111-111111111111",
      name: "Hall",
      last_updated: "2026-06-30T00:00:00.000Z",
    },
  };
  const plan = createRegionShotPlan({ target, config, workerResult, adjustment });

  assert.equal(plan.region_group_name, "Hall");
  assert.equal(plan.kind, "region_group");
  assert.deepEqual(plan.plan.points, adjustment.points);
  assert.equal(plan.plan.target_cells, undefined);
  assert.equal(plan.coverage.target_area, 2);
  assert.equal(plan.coverage.final_count, 1);
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
