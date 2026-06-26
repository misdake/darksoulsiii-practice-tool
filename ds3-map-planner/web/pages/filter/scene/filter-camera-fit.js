import * as THREE from "three";

export function isObjectHierarchyVisible(obj) {
  let current = obj;
  while (current) {
    if (current.visible === false) return false;
    current = current.parent;
  }
  return true;
}

export function fitCameraToVisibleObjects({ camera, root, groups, controls }) {
  if (!groups.some(Boolean)) return false;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const group of groups) {
    if (!group || !isObjectHierarchyVisible(group)) continue;
    group.traverse((obj) => {
      if (!obj.isMesh || !isObjectHierarchyVisible(obj)) return;
      box.expandByObject(obj);
    });
  }
  if (box.isEmpty()) return false;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.9 + 1;
  camera.position
    .copy(center)
    .add(new THREE.Vector3(radius, radius * 0.7, radius));
  controls.target.copy(center);
  controls.update();
  return true;
}
