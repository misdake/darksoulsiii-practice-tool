import { applyEnabledPaths, navSegmentKey } from "../stage-runtime/filter-stage-state.js";
import { applySelectedNavSegments } from "../stage-runtime/filter-stage-data.js";
import { displayName } from "./filter-map-keys.js";

export function attachLoadedFilterMapData({
  root,
  loaded,
  collisionSystem,
  navSystem,
  visualController,
  navSegmentUsageStates,
}) {
  const { collisionGroup, navmeshGroup } = loaded;

  collisionSystem.setGroup(collisionGroup);
  navSystem.setGroup(navmeshGroup);
  root.add(collisionGroup);
  root.add(navmeshGroup);

  visualController.applyCollisionMaterial(collisionGroup, 0.5);
  visualController.applyDefaultVisibilityRules(loaded.defaultHitFilterIds);

  applyEnabledPaths(
    collisionGroup,
    loaded.stage1Data?.collision_enabled_paths,
    displayName,
  );
  applyEnabledPaths(
    navmeshGroup,
    loaded.stage2Data?.nav_enabled_paths,
    displayName,
  );
  applySelectedNavSegments(
    loaded.stage3Data,
    navSegmentUsageStates,
    navSegmentKey,
  );
}
