import * as THREE from "three";
import { disposeObjectTree } from "../../../shared/map-runtime.js";

const UNCOVERED_COLOR = 0xef4444;

export function renderUncoveredPoints(group, points) {
  disposeObjectTree(group);
  if (!points.length) {
    return;
  }

  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.3, 8, 6),
    new THREE.MeshBasicMaterial({ color: UNCOVERED_COLOR }),
    points.length,
  );
  const matrix = new THREE.Matrix4();

  points.forEach(([x, y, z], index) => {
    matrix.makeTranslation(x, y, z);
    mesh.setMatrixAt(index, matrix);
  });

  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
}
