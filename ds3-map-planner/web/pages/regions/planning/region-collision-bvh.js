import * as THREE from "three";
import { computeGeometryBoundsTree } from "../../../shared/bvh.js";

export function createMergedCollisionMesh(collisionGroup) {
  const positions = [];
  collisionGroup?.updateMatrixWorld(true);
  collisionGroup?.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    const source = object.geometry.index
      ? object.geometry.toNonIndexed()
      : object.geometry.clone();
    const position = source.getAttribute("position");
    const vertex = new THREE.Vector3();
    for (let index = 0; index < position.count; index += 1) {
      vertex
        .set(position.getX(index), position.getY(index), position.getZ(index))
        .applyMatrix4(object.matrixWorld);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
    source.dispose();
  });

  if (!positions.length) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  computeGeometryBoundsTree(geometry);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  mesh.visible = false;
  return mesh;
}
