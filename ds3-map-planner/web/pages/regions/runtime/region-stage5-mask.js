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

export function applyRegionClipping(scene, region) {
  const planes = [
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -region.ymin),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), region.ymax),
  ];

  scene.traverse((object) => {
    if (!object.isMesh) {
      return;
    }

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
