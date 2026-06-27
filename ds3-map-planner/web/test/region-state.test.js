import test from "node:test";
import assert from "node:assert/strict";
import { RegionState } from "../pages/regions/state/region-state.js";

test("region state selects loaded regions and replaces plans by region name", () => {
  const state = new RegionState();
  state.load({ mapId: "m30_00_00_00", regions: [{ name: "A" }], plans: [] });
  assert.equal(state.selectedRegion.name, "A");
  state.replacePlan({ region_name: "A", plan: { points: [] } });
  state.replacePlan({ region_name: "A", plan: { points: [1] } });
  assert.equal(state.plans.length, 1);
  assert.deepEqual(state.plans[0].plan.points, [1]);
});

test("region groups normalize to one explicit group per region", () => {
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
});

test("grouping selected regions extracts them from existing groups", () => {
  const state = new RegionState();
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
});

test("grouping one selected region splits it into its own display group", () => {
  const state = new RegionState();
  state.load({
    mapId: "m30_00_00_00",
    regions: [{ name: "A" }, { name: "B" }, { name: "C" }],
    regionGroups: [{ regions: ["A", "B", "C"] }],
    plans: [],
  });

  state.select(1);

  assert.equal(state.groupSelectedRegions(), true);
  assert.deepEqual(state.regionGroups, [{ regions: ["A", "C"] }]);
});

test("region groups follow rename and delete", () => {
  const state = new RegionState();
  state.load({
    mapId: "m30_00_00_00",
    regions: [{ name: "A" }, { name: "B" }, { name: "C" }],
    regionGroups: [{ regions: ["A", "B", "C"] }],
    plans: [],
  });

  state.regions[1].name = "B2";
  state.renameRegion("B", "B2");
  assert.deepEqual(state.regionGroups, [{ regions: ["A", "B2", "C"] }]);

  state.select(1);
  state.removeSelected();
  assert.deepEqual(state.regionGroups, [{ regions: ["A", "C"] }]);
});
