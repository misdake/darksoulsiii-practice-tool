import * as THREE from "three";

export function cloneStage5SourceScene(navGroup, collisionGroup) {
  return cloneClippedSourceScene(navGroup, collisionGroup);
}

export function cloneClippedSourceScene(
  navGroup,
  collisionGroup,
  { includeNavmesh = false, preserveMaterials = false } = {},
) {
  const scene = new THREE.Scene();
  if (preserveMaterials) {
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
    directionalLight.position.set(120, 220, 100);
    scene.add(directionalLight);
  }
  if (includeNavmesh) {
    scene.add(cloneMeshTree(navGroup, { preserveMaterials }));
  }
  scene.add(cloneMeshTree(collisionGroup, { preserveMaterials }));
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

function cloneMeshTree(source, { preserveMaterials = false } = {}) {
  const root = new THREE.Group();
  root.userData.sourceGroup = source;

  source?.traverse((object) => {
    if (!object.isMesh) {
      return;
    }

    object.updateWorldMatrix(true, false);
    const material = preserveMaterials
      ? cloneSourceMaterial(object.material)
      : new THREE.MeshBasicMaterial({
          color:
            object.userData.kind === "navmesh-split" ? 0x4ade80 : 0x94a3b8,
          side: THREE.DoubleSide,
          transparent: false,
          opacity: 1,
        });
    const clone = new THREE.Mesh(object.geometry, material);
    clone.matrix.copy(object.matrixWorld);
    clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
    clone.userData.kind = object.userData.kind;
    clone.userData.sourceObject = object;
    clone.updateMatrixWorld(true);
    clone.userData.worldBounds = new THREE.Box3().setFromObject(clone);
    root.add(clone);
  });

  return root;
}

function cloneSourceMaterial(source) {
  const clone = (material) => {
    const result = material.clone();
    result.onBeforeCompile = material.onBeforeCompile;
    result.needsUpdate = true;
    return result;
  };
  return Array.isArray(source) ? source.map(clone) : clone(source);
}

export function syncClippedSourceScene(scene) {
  for (const root of scene.children) {
    const sourceGroup = root.userData?.sourceGroup;
    if (sourceGroup) root.visible = sourceGroup.visible;
  }
  scene.traverse((object) => {
    const source = object.userData?.sourceObject;
    if (!object.isMesh || !source?.isMesh) return;
    object.visible = source.visible;
    const targetMaterials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    const sourceMaterials = Array.isArray(source.material)
      ? source.material
      : [source.material];
    targetMaterials.forEach((material, index) => {
      const sourceMaterial = sourceMaterials[index];
      if (!sourceMaterial) return;
      const needsUpdate = material.transparent !== sourceMaterial.transparent;
      material.color?.copy(sourceMaterial.color);
      material.opacity = sourceMaterial.opacity;
      material.transparent = sourceMaterial.transparent;
      material.depthWrite = sourceMaterial.depthWrite;
      if (needsUpdate) material.needsUpdate = true;
    });
  });
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
    object.visible = object.userData.worldBounds?.intersectsBox(bounds) ?? true;
  });
}
