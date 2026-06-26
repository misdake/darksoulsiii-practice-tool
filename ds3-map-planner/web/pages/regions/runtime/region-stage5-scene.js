import * as THREE from "three";

export function cloneStage5SourceScene(navGroup, collisionGroup) {
  const scene = new THREE.Scene();
  scene.add(cloneMeshTree(collisionGroup));
  return scene;
}

export function disposeStage5Scene(scene, { disposeGeometry = false } = {}) {
  scene.traverse((object) => {
    if (object.isMesh) {
      if (disposeGeometry) {
        object.geometry?.dispose?.();
      }
      object.material?.dispose?.();
    }
  });
  scene.clear();
}

function cloneMeshTree(source) {
  const root = new THREE.Group();

  source?.traverse((object) => {
    if (!object.isMesh) {
      return;
    }

    object.updateWorldMatrix(true, false);
    const material = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
    });
    const clone = new THREE.Mesh(object.geometry, material);
    clone.matrix.copy(object.matrixWorld);
    clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
    clone.userData.kind = object.userData.kind;
    root.add(clone);
  });

  return root;
}
