import * as THREE from "three";
import { createGeometry } from "../../../shared/map-runtime.js";
import {
  createHeightBandNavmeshMaterial,
  createRegionNavmeshMaterial,
} from "./region-asset-materials.js";

export async function loadSelectedNavmesh({
  parser,
  content,
  stage2,
  stage3,
  requireSelection = false,
  onProgress,
}) {
  const group = new THREE.Group();
  const enabled = new Set(stage2?.nav_enabled_paths || []);
  const selected = selectedNavSegmentKeys(stage3);
  const selectedPaths = selectedNavPaths(stage3);

  if (requireSelection && selected.size === 0) {
    return group;
  }

  for (const nav of content?.navmesh_manifest?.navmeshes || []) {
    if (enabled.size && !enabled.has(nav.path)) {
      continue;
    }
    if (selectedPaths.size && !selectedPaths.has(nav.path)) {
      continue;
    }

    const parsed = await parser.parse(nav.path);
    onProgress?.();
    for (const [index, data] of (parsed.meshes || []).entries()) {
      if (selected.size && !selected.has(navSegmentKey(nav.path, index))) {
        continue;
      }

      group.add(createNavmeshSplitMesh(nav.path, index, data));
    }
  }

  applyHeightBandMaterials(group);
  return group;
}

function selectedNavPaths(stage3Data) {
  const selected = Array.isArray(stage3Data?.selected_nav_segments)
    ? stage3Data.selected_nav_segments
    : [];

  return new Set(
    selected
      .filter((item) => typeof item?.nav_name === "string")
      .map((item) => item.nav_name),
  );
}

export function applyHeightBandMaterials(group) {
  const range = navmeshWorldYRange(group);
  if (!range) return;

  group.traverse((object) => {
    if (!object.isMesh) return;
    object.material?.dispose?.();
    object.material = createHeightBandNavmeshMaterial(range.min, range.max);
  });
}

export function navmeshWorldYRange(group) {
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

function createNavmeshSplitMesh(path, index, data) {
  const geometry = createGeometry(data);
  const mesh = new THREE.Mesh(geometry, createRegionNavmeshMaterial());
  mesh.userData.navPath = path;
  mesh.userData.segmentIndex = index;
  mesh.userData.kind = "navmesh-split";
  return mesh;
}

function selectedNavSegmentKeys(stage3Data) {
  const selected = Array.isArray(stage3Data?.selected_nav_segments)
    ? stage3Data.selected_nav_segments
    : [];

  return new Set(
    selected
      .filter((item) => typeof item?.nav_name === "string")
      .map((item) => navSegmentKey(item.nav_name, item.segment_index)),
  );
}

function navSegmentKey(navPath, segmentIndex) {
  return `${navPath}::${Number(segmentIndex)}`;
}
