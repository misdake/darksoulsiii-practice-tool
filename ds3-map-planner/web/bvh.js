import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

export function computeGeometryBoundsTree(geometry) {
  if (geometry?.index && typeof geometry.computeBoundsTree === "function") {
    geometry.computeBoundsTree();
  }
  return geometry;
}
