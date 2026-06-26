import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEnabledPaths,
  navSegmentKey,
  selectedNavSegmentKeys,
} from "../pages/filter/stage-runtime/filter-stage-state.js";
import { FilterNavSegmentUsage } from "../pages/filter/stage-runtime/filter-nav-segment-usage.js";
import { visibleStateFor } from "../pages/filter/ui/filter-visibility-state.js";

test("selected nav segments use stable path and index keys", () => {
  const keys = selectedNavSegmentKeys({
    selected_nav_segments: [{ nav_name: "a.obj", segment_index: 2 }],
  });
  assert.equal(keys.has(navSegmentKey("a.obj", 2)), true);
});

test("enabled paths match exact paths and display names", () => {
  const group = {
    children: [
      { name: "dir/a.obj", userData: {} },
      { name: "dir/b.obj", userData: {} },
    ],
  };
  applyEnabledPaths(group, ["a.obj"], (value) => value.split("/").at(-1));
  assert.equal(group.children[0].userData.manualEnabled, true);
  assert.equal(group.children[1].userData.manualEnabled, false);
});

test("nav segment usage exposes visual state from shared map", () => {
  const usage = new FilterNavSegmentUsage();
  usage.states.set(navSegmentKey("m10.navmesh.obj", 4), true);

  assert.equal(usage.getUsage("m10.navmesh.obj", 4), true);
  assert.equal(usage.getState("m10.navmesh.obj", 4), "selected");
  assert.equal(usage.getState("m10.navmesh.obj", 5), "unset");

  usage.clear();
  assert.equal(usage.getUsage("m10.navmesh.obj", 4), false);
});

test("visibility state distinguishes visible hidden and partial groups", () => {
  assert.equal(
    visibleStateFor([{ userData: {} }, { userData: {} }]).state,
    "visible",
  );
  assert.equal(
    visibleStateFor([
      { userData: { manualEnabled: false } },
      { userData: { manualEnabled: false } },
    ]).state,
    "hidden",
  );
  assert.equal(
    visibleStateFor([{ userData: {} }, { userData: { manualEnabled: false } }])
      .state,
    "partial",
  );
});
