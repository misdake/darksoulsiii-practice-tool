import test from "node:test";
import assert from "node:assert/strict";
import {
  flattenPrisms,
  nextRegionGroupName,
  RegionState,
} from "../pages/regions/state/region-state.js";
import {
  findRegionGroupOverlaps,
  validateRegionGroups,
} from "../pages/regions/geometry/region-geometry.js";
import { isPlanValid } from "../pages/regions/actions/region-plan-actions.js";
import { RegionPageSyncController } from "../pages/regions/state/region-page-sync-controller.js";

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const T0 = "2026-06-30T00:00:00.000Z";
const T1 = "2026-06-30T00:00:01.000Z";

test("region group schema rejects old and malformed data", () => {
  const state = createState();
  assert.throws(() => state.load({ mapId: "map", regions: [], plans: [] }), /old regions schema/i);
  assert.match(validateRegionGroups([{ uuid: UUIDS[0], name: "", last_updated: T0, prisms: [prism()] }]), /name/i);
  assert.match(validateRegionGroups([{ uuid: UUIDS[0], name: "A", last_updated: T0, prisms: [] }]), /one prism/i);
  assert.match(validateRegionGroups([
    group(UUIDS[0], "A", [prism()]),
    group(UUIDS[0], "A", [prism(4)]),
  ]), /duplicated/i);
});

test("cross-group overlap is allowed by validation and reported only on demand", () => {
  const overlapping = [
    group(UUIDS[0], "A", [prism()]),
    group(UUIDS[1], "B", [prism(0.25)]),
  ];
  assert.equal(validateRegionGroups(overlapping), null);
  const overlaps = findRegionGroupOverlaps(overlapping);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].leftPrismIndex, 0);
  assert.equal(overlaps[0].rightPrismIndex, 0);
  assert.equal(findRegionGroupOverlaps([
    group(UUIDS[0], "A", [prism(), prism(0.25)]),
  ]).length, 0);
});

test("selection, regroup, singleton extraction and deletion use prism identity", () => {
  const state = createState();
  const a = prism();
  const b = prism(4);
  const c = prism(8);
  state.load({ mapId: "map", regionGroups: [group(UUIDS[0], "A", [a, b]), group(UUIDS[1], "B", [c])], plans: [] });
  state.restorePrismSelection([b, c], c);
  assert.equal(state.groupSelectedRegions(), true);
  assert.deepEqual(state.regionGroups[0].prisms, [a, b, c]);
  assert.equal(state.regionGroups.length, 1);
  assert.equal(state.regionGroups[0].uuid, UUIDS[0]);
  assert.equal(state.regionGroups[0].last_updated, T1);

  state.restorePrismSelection([b], b);
  assert.equal(state.groupSelectedRegions(), true);
  assert.equal(state.regionGroups.length, 2);
  assert.notEqual(state.regionGroups[1].uuid, UUIDS[0]);
  assert.deepEqual(state.regionGroups[1].prisms, [b]);
  state.removeSelected();
  assert.equal(state.regionGroups.length, 1);
  assert.deepEqual(flattenPrisms(state.regionGroups).map(({ prism: item }) => item), [a, c]);
});

test("split keeps the lower prism in its group and creates a new upper group", () => {
  const state = createState();
  const original = prism();
  state.load({ mapId: "map", regionGroups: [group(UUIDS[0], "Same", [original])], plans: [] });
  const result = state.splitSelectedHeight();
  assert.deepEqual([result.lower.ymin, result.lower.ymax], [0, 1.5]);
  assert.deepEqual([result.upper.ymin, result.upper.ymax], [1.5, 3]);
  assert.equal(state.regionGroups[0].uuid, UUIDS[0]);
  assert.equal(state.regionGroups[1].uuid, UUIDS[1]);
  assert.equal(nextRegionGroupName([{ name: "Region Group 2" }]), "Region Group 1");
});

test("plans are keyed by UUID and group timestamp", () => {
  const state = createState();
  const current = group(UUIDS[0], "Duplicate", [prism()]);
  state.load({ mapId: "map", regionGroups: [current, group(UUIDS[1], "Duplicate", [prism(4)])], plans: [] });
  state.replacePlan({ kind: "region_group", region_group_uuid: UUIDS[0], group_last_updated: T0, plan: { points: [] } });
  state.replacePlan({ kind: "region_group", region_group_uuid: UUIDS[0], group_last_updated: T0, plan: { points: [1] } });
  state.replacePlan({ kind: "fallback", plan: { points: [] } });
  assert.equal(state.plans.length, 2);
  assert.deepEqual(state.plans[0].plan.points, [1]);
  assert.equal(isPlanValid(state.plans[0], state.regionGroups), true);
  current.last_updated = T1;
  assert.equal(isPlanValid(state.plans[0], state.regionGroups), false);
});

test("invalid polygon edits are reverted while valid edits are left unchanged", () => {
  let status = "";
  const controller = new RegionPageSyncController({
    state: createState(),
    ui: { status: (message) => { status = message; } },
    runtime: {},
  });
  const before = [[0, 0], [1, 0], [0, 1]];
  const invalid = { ymin: 0, ymax: 3, polygon_xz: [[0, 0], [1, 1]] };
  assert.equal(controller.revertInvalidEdit(invalid, before), true);
  assert.equal(invalid.polygon_xz, before);
  assert.match(status, /at least three/i);

  const valid = prism();
  const validPolygon = valid.polygon_xz;
  assert.equal(controller.revertInvalidEdit(valid, before), false);
  assert.equal(valid.polygon_xz, validPolygon);
});

function createState() {
  let uuidIndex = 1;
  return new RegionState({ now: () => T1, randomUUID: () => UUIDS[uuidIndex++ % UUIDS.length] });
}

function prism(offset = 0) {
  return { ymin: 0, ymax: 3, polygon_xz: [[offset, 0], [offset + 1, 0], [offset, 1]] };
}

function group(uuid, name, prisms) {
  return { uuid, name, last_updated: T0, prisms };
}
