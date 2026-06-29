import * as THREE from "three";

export function createRegionMask(region) {
  const points = region.polygon_xz.map(([x, z]) => new THREE.Vector2(x, z));
  const shape = new THREE.Shape(points);
  const geometry = new THREE.ShapeGeometry(shape);
  const material = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  const mask = new THREE.Mesh(geometry, material);
  mask.rotation.x = Math.PI / 2;
  mask.position.y = region.ymin - 0.01;
  return mask;
}

export function applyRegionBroadPhase(scene, region) {
  const xs = region.polygon_xz.map(([x]) => x);
  const zs = region.polygon_xz.map(([, z]) => z);
  const bounds = new THREE.Box3(
    new THREE.Vector3(Math.min(...xs), region.ymin, Math.min(...zs)),
    new THREE.Vector3(Math.max(...xs), region.ymax, Math.max(...zs)),
  );

  scene.traverse((object) => {
    if (!object.isMesh) return;
    if (!object.userData.worldBounds) {
      object.updateWorldMatrix(true, false);
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      object.userData.worldBounds = object.geometry.boundingBox
        .clone()
        .applyMatrix4(object.matrixWorld);
    }
    object.visible =
      object.visible && object.userData.worldBounds.intersectsBox(bounds);
  });
}

export function applyRegionClipping(scene, region) {
  const planes = regionClippingPlanes(region);
  scene.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      material.clippingPlanes = planes;
      material.stencilWrite = true;
      material.stencilRef = 1;
      material.stencilFunc = THREE.EqualStencilFunc;
      material.stencilZPass = THREE.KeepStencilOp;
    }
  });
}

export function regionClippingPlanes(region) {
  return [
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -region.ymin),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), region.ymax),
  ];
}
