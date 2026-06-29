import * as THREE from "three";
import { computeGeometryBoundsTree } from "../../../shared/bvh.js";
import {
  loadOptionalStages,
  stageUrl,
  fetchOptionalJson,
} from "../../../shared/map-api.js";
import { createGeometry } from "../../../shared/map-runtime.js";
import {
  createHeightBandNavmeshMaterial,
  createRegionCollisionMaterial,
} from "./region-asset-materials.js";

export class RegionAssetLoader {
  constructor(parser) {
    this.parser = parser;
  }

  async load(mapId, { targetCount = 1, onProgress } = {}) {
    const content = await fetchOptionalJson(stageUrl(mapId, "content"));
    const stages = await loadOptionalStages(mapId, [
      "stage1-collision-filter",
      "stage2-nav-filter",
      "stage3-mark-nav",
    ]);
    const count = Math.max(1, targetCount);
    const targets = createAssetTargets(count);
    const totalEntries = countRegionAssetEntries(content, stages);
    let loadedEntries = 0;
    const updateProgress = () => {
      loadedEntries += 1;
      onProgress?.(totalEntries ? loadedEntries / totalEntries : 1);
    };

    try {
      await loadSelectedNavmesh({
        parser: this.parser,
        content,
        stage2: stages["stage2-nav-filter"],
        stage3: stages["stage3-mark-nav"],
        targets,
        onProgress: updateProgress,
      });
      await loadEnabledCollision({
        parser: this.parser,
        content,
        stage1: stages["stage1-collision-filter"],
        targets,
        onProgress: updateProgress,
      });
      targets[0].collision.traverse((object) => {
        if (object.isMesh) computeGeometryBoundsTree(object.geometry);
      });
      cacheTargetWorldBounds(targets);
      if (!totalEntries) onProgress?.(1);
      return new RegionAssetBundle(targets);
    } catch (error) {
      disposeRegionAssetTargets(targets);
      throw error;
    }
  }
}

export class RegionAssetBundle {
  constructor(targets) {
    this.targets = targets;
    this.counts = {
      navmeshCount: targets[0]?.navmesh.children.length || 0,
      collisionCount: targets[0]?.collision.children.length || 0,
    };
  }

  install(liveTargets) {
    if (!this.targets.length) {
      throw new Error("Region asset bundle was already consumed.");
    }
    if (liveTargets.length !== this.targets.length) {
      throw new Error("Region asset target count changed during loading.");
    }

    disposeRegionAssetTargets(liveTargets);
    liveTargets.forEach((target, index) => {
      const source = this.targets[index];
      moveChildren(source.navmesh, target.navmesh);
      moveChildren(source.collision, target.collision);
    });
    this.targets = [];
    return this.counts;
  }

  dispose() {
    disposeRegionAssetTargets(this.targets);
    this.targets = [];
  }
}

function moveChildren(source, target) {
  for (const child of [...source.children]) target.add(child);
}

export function disposeRegionAssetTargets(targets) {
  const geometries = new Set();
  const materials = new Set();
  for (const target of targets || []) {
    for (const group of [target.navmesh, target.collision]) {
      group?.traverse?.((object) => {
        if (!object.isMesh) return;
        if (object.geometry) geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of objectMaterials) {
          if (material) materials.add(material);
        }
      });
      group?.clear?.();
    }
  }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) {
    geometry.disposeBoundsTree?.();
    geometry.dispose();
  }
}

function createAssetTargets(count) {
  return Array.from({ length: count }, () => ({
    navmesh: new THREE.Group(),
    collision: new THREE.Group(),
  }));
}

async function loadSelectedNavmesh({
  parser,
  content,
  stage2,
  stage3,
  targets,
  onProgress,
}) {
  const enabled = new Set(asArray(stage2?.nav_enabled_paths));
  const selected = selectedNavSegmentKeys(stage3);
  const selectedPaths = new Set(
    asArray(stage3?.selected_nav_segments)
      .filter((item) => typeof item?.nav_name === "string")
      .map((item) => item.nav_name),
  );
  if (!selected.size) return;

  for (const nav of content?.navmesh_manifest?.navmeshes || []) {
    if (enabled.size && !enabled.has(nav.path)) continue;
    if (selectedPaths.size && !selectedPaths.has(nav.path)) continue;
    const parsed = await parser.parse(nav.path);
    onProgress?.();
    for (const [index, data] of (parsed.meshes || []).entries()) {
      if (!selected.has(navSegmentKey(nav.path, index))) continue;
      const geometry = createGeometry(data);
      for (const target of targets) {
        const mesh = new THREE.Mesh(geometry, null);
        mesh.userData.navPath = nav.path;
        mesh.userData.segmentIndex = index;
        mesh.userData.kind = "navmesh-split";
        target.navmesh.add(mesh);
      }
    }
  }

  const range = navmeshWorldYRange(targets[0].navmesh);
  if (!range) return;
  for (const target of targets) {
    target.navmesh.traverse((object) => {
      if (!object.isMesh) return;
      object.material = createHeightBandNavmeshMaterial(range.min, range.max);
    });
  }
}

async function loadEnabledCollision({
  parser,
  content,
  stage1,
  targets,
  onProgress,
}) {
  const enabled = new Set(asArray(stage1?.collision_enabled_paths));
  for (const entry of content?.collision_manifest?.instances || []) {
    const path = entry.path || entry.obj_path || entry.OutObjFile;
    const baseName = String(path).replace(/\\/g, "/").split("/").at(-1);
    if (!path || (enabled.size && !enabled.has(path) && !enabled.has(baseName))) {
      continue;
    }
    const parsed = await parser.parse(path);
    onProgress?.();
    for (const data of parsed.meshes || []) {
      const geometry = createGeometry(data);
      for (const target of targets) {
        const mesh = new THREE.Mesh(geometry, createRegionCollisionMaterial());
        mesh.userData.kind = "collision";
        mesh.userData.sourcePath = path;
        target.collision.add(mesh);
      }
    }
  }
}

function navmeshWorldYRange(group) {
  let min = Infinity;
  let max = -Infinity;
  const vertex = new THREE.Vector3();
  group.updateMatrixWorld(true);
  group.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    const position = object.geometry.getAttribute("position");
    for (let index = 0; index < position.count; index += 1) {
      vertex
        .set(position.getX(index), position.getY(index), position.getZ(index))
        .applyMatrix4(object.matrixWorld);
      min = Math.min(min, vertex.y);
      max = Math.max(max, vertex.y);
    }
  });
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

function cacheTargetWorldBounds(targets) {
  for (const target of targets) {
    for (const group of [target.navmesh, target.collision]) {
      group.updateMatrixWorld(true);
      group.traverse((object) => {
        if (!object.isMesh) return;
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        object.userData.worldBounds = object.geometry.boundingBox
          .clone()
          .applyMatrix4(object.matrixWorld);
      });
    }
  }
}

function selectedNavSegmentKeys(stage3Data) {
  return new Set(
    asArray(stage3Data?.selected_nav_segments)
      .filter((item) => typeof item?.nav_name === "string")
      .map((item) => navSegmentKey(item.nav_name, item.segment_index)),
  );
}

function navSegmentKey(navPath, segmentIndex) {
  return `${navPath}::${Number(segmentIndex)}`;
}

function countRegionAssetEntries(content, stages) {
  const enabledNav = new Set(
    asArray(stages["stage2-nav-filter"]?.nav_enabled_paths),
  );
  const selectedPaths = new Set(
    asArray(stages["stage3-mark-nav"]?.selected_nav_segments)
      .map((item) => item?.nav_name)
      .filter(Boolean),
  );
  const navCount = selectedPaths.size
    ? (content?.navmesh_manifest?.navmeshes || []).filter(
        (nav) =>
          (!enabledNav.size || enabledNav.has(nav.path)) &&
          selectedPaths.has(nav.path),
      ).length
    : 0;
  const enabledCollision = new Set(
    asArray(stages["stage1-collision-filter"]?.collision_enabled_paths),
  );
  const collisionCount = (content?.collision_manifest?.instances || []).filter(
    (entry) => {
      const path = entry.path || entry.obj_path || entry.OutObjFile;
      const baseName = String(path).replace(/\\/g, "/").split("/").at(-1);
      return path &&
        (!enabledCollision.size ||
          enabledCollision.has(path) ||
          enabledCollision.has(baseName));
    },
  ).length;
  return navCount + collisionCount;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
