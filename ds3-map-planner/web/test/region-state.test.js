import test from "node:test";
import assert from "node:assert/strict";
import { RegionState } from "../pages/regions/state/region-state.js";
import { RegionPageSyncController } from "../pages/regions/state/region-page-sync-controller.js";

test("region state loads selection and replaces plans by region name", () => {
  const state = new RegionState();
  state.load({ mapId: "m30_00_00_00", regions: [{ name: "A" }], plans: [] });
  assert.equal(state.selectedRegion.name, "A");
  state.replacePlan({ region_name: "A", plan: { points: [] } });
  state.replacePlan({ region_name: "A", plan: { points: [1] } });
  assert.equal(state.plans.length, 1);
  assert.deepEqual(state.plans[0].plan.points, [1]);
});

test("region groups normalize, regroup, split, rename and delete", () => {
  const state = new RegionState();
  state.load({
    mapId: "m30_00_00_00",
    regions: [{ name: "A" }, { name: "B" }, { name: "C" }],
    regionGroups: [
      { regions: ["A", "B", "missing"] },
      { regions: ["B", "C"] },
    ],
    plans: [],
  });

  assert.deepEqual(state.regionGroups, [{ regions: ["A", "B"] }]);

  state.load({
    mapId: "m30_00_00_00",
    regions: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
    regionGroups: [{ regions: ["A", "B", "C"] }],
    plans: [],
  });
  state.select(1);
  state.toggleSelected(3);
  assert.equal(state.groupSelectedRegions(), true);
  assert.deepEqual(state.regionGroups, [
    { regions: ["A", "C"] },
    { regions: ["B", "D"] },
  ]);

  state.select(1);
  assert.equal(state.groupSelectedRegions(), true);
  assert.deepEqual(state.regionGroups, [{ regions: ["A", "C"] }]);

  state.regions[1].name = "B2";
  state.renameRegion("B", "B2");
  state.select(0);
  state.toggleSelected(1);
  assert.equal(state.groupSelectedRegions(), true);
  assert.deepEqual(state.regionGroups, [
    { regions: ["A", "B2"] },
    { regions: ["C"] },
    { regions: ["D"] },
  ].filter((group) => group.regions.length > 1));

  state.select(1);
  state.removeSelected();
  assert.deepEqual(state.regionGroups, []);
});

test("invalid duplicate rename does not mutate regions or groups", () => {
  const state = new RegionState();
  state.load({
    mapId: "m30_00_00_00",
    regions: [
      { name: "A", ymin: 0, ymax: 3, polygon_xz: [[0, 0], [1, 0], [0, 1]] },
      { name: "B", ymin: 0, ymax: 3, polygon_xz: [[2, 0], [3, 0], [2, 1]] },
    ],
    regionGroups: [{ regions: ["A", "B"] }],
    plans: [],
  });
  state.select(1);
  let error = "";
  const controller = new RegionPageSyncController({
    state,
    ui: {
      readEditor: () => ({ name: "A", ymin: 0, ymax: 3 }),
      status: (message) => {
        error = message;
      },
    },
    runtime: {},
  });

  assert.equal(controller.applyEditorFields(), false);
  assert.equal(state.regions[1].name, "B");
  assert.deepEqual(state.regionGroups, [{ regions: ["A", "B"] }]);
  assert.match(error, /duplicated/i);
});
