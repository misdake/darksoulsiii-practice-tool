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
