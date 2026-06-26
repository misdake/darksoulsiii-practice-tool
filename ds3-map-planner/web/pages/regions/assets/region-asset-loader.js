import { computeGeometryBoundsTree } from "../../../shared/bvh.js";
import {
  loadOptionalStages,
  stageUrl,
  fetchOptionalJson,
} from "../../../shared/map-api.js";
import { disposeObjectTree } from "../../../shared/map-runtime.js";
import { loadEnabledCollision } from "./region-collision-asset-loader.js";
import { loadSelectedNavmesh } from "./region-navmesh-asset-loader.js";

export class RegionAssetLoader {
  constructor(parser) {
    this.parser = parser;
  }

  async load(mapId, groups, { onProgress } = {}) {
    const content = await fetchOptionalJson(stageUrl(mapId, "content"));
    const stages = await loadOptionalStages(mapId, [
      "stage1-collision-filter",
      "stage2-nav-filter",
      "stage3-mark-nav",
    ]);
    disposeObjectTree(groups.navmesh);
    disposeObjectTree(groups.collision);
    const totalEntries = countRegionAssetEntries(content, stages);
    let loadedEntries = 0;
    const updateProgress = () => {
      if (totalEntries <= 0) {
        onProgress?.(1);
        return;
      }
      loadedEntries += 1;
      onProgress?.(loadedEntries / totalEntries);
    };
    const navmesh = await loadSelectedNavmesh({
      parser: this.parser,
      content,
      stage2: stages["stage2-nav-filter"],
      stage3: stages["stage3-mark-nav"],
      requireSelection: true,
      onProgress: updateProgress,
    });
    const collision = await loadEnabledCollision({
      parser: this.parser,
      content,
      stage1: stages["stage1-collision-filter"],
      onProgress: updateProgress,
    });
    groups.navmesh.add(...navmesh.children);
    groups.collision.add(...collision.children);
    groups.collision.traverse((object) => {
      if (object.isMesh) computeGeometryBoundsTree(object.geometry);
    });
    return {
      navmeshCount: groups.navmesh.children.length,
      collisionCount: groups.collision.children.length,
    };
  }
}

function countRegionAssetEntries(content, stages) {
  return (
    countSelectedNavmeshEntries({
      content,
      stage2: stages["stage2-nav-filter"],
      stage3: stages["stage3-mark-nav"],
    }) +
    countEnabledCollisionEntries({
      content,
      stage1: stages["stage1-collision-filter"],
    })
  );
}

function countSelectedNavmeshEntries({ content, stage2, stage3 }) {
  const enabled = new Set(stage2?.nav_enabled_paths || []);
  const selected = new Set(
    (Array.isArray(stage3?.selected_nav_segments)
      ? stage3.selected_nav_segments
      : [])
      .filter((item) => typeof item?.nav_name === "string")
      .map((item) => item.nav_name),
  );
  if (!selected.size) return 0;
  return (content?.navmesh_manifest?.navmeshes || []).filter(
    (nav) =>
      (!enabled.size || enabled.has(nav.path)) &&
      (!selected.size || selected.has(nav.path)),
  ).length;
}

function countEnabledCollisionEntries({ content, stage1 }) {
  const enabled = new Set(stage1?.collision_enabled_paths || []);
  return (content?.collision_manifest?.instances || []).filter((entry) => {
    const path = entry.path || entry.obj_path || entry.OutObjFile;
    const baseName = String(path).replace(/\\/g, "/").split("/").at(-1);
    return path && (!enabled.size || enabled.has(path) || enabled.has(baseName));
  }).length;
}
