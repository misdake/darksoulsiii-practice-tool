import * as THREE from "three";
import { createGeometry } from "../../../shared/map-runtime.js";
import { createRegionCollisionMaterial } from "./region-asset-materials.js";

export async function loadEnabledCollision({
  parser,
  content,
  stage1,
  onProgress,
}) {
  const group = new THREE.Group();
  const enabled = new Set(stage1?.collision_enabled_paths || []);

  for (const entry of content?.collision_manifest?.instances || []) {
    const path = entry.path || entry.obj_path || entry.OutObjFile;
    const baseName = String(path).replace(/\\/g, "/").split("/").at(-1);
    const isEnabled =
      !enabled.size || enabled.has(path) || enabled.has(baseName);
    if (!path || !isEnabled) {
      continue;
    }

    const parsed = await parser.parse(path);
    onProgress?.();
    for (const data of parsed.meshes || []) {
      group.add(createCollisionMesh(path, data));
    }
  }

  return group;
}

function createCollisionMesh(path, data) {
  const mesh = new THREE.Mesh(
    createGeometry(data),
    createRegionCollisionMaterial(),
  );
  mesh.userData.kind = "collision";
  mesh.userData.sourcePath = path;
  return mesh;
}
