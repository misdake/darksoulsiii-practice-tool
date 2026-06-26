export function captureMaterialState(group) {
  const state = new Map();
  group?.traverse((object) => {
    if (!object.isMesh || !object.material) {
      return;
    }

    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    state.set(
      object,
      materials.map((material) => ({
        color: material.color?.clone?.(),
        opacity: material.opacity,
        transparent: material.transparent,
        depthWrite: material.depthWrite,
        clippingPlanes: material.clippingPlanes,
        stencilWrite: material.stencilWrite,
        stencilRef: material.stencilRef,
        stencilFunc: material.stencilFunc,
        stencilZPass: material.stencilZPass,
        visible: object.visible,
      })),
    );
  });
  return state;
}

export function restoreMaterialState(state) {
  for (const [object, materials] of state) {
    const current = Array.isArray(object.material)
      ? object.material
      : [object.material];
    materials.forEach((saved, index) => {
      const material = current[index];
      if (!material) {
        return;
      }
      if (saved.color && material.color) {
        material.color.copy(saved.color);
      }

      material.opacity = saved.opacity;
      material.transparent = saved.transparent;
      material.depthWrite = saved.depthWrite;
      material.clippingPlanes = saved.clippingPlanes;
      material.stencilWrite = saved.stencilWrite;
      material.stencilRef = saved.stencilRef;
      material.stencilFunc = saved.stencilFunc;
      material.stencilZPass = saved.stencilZPass;
      material.needsUpdate = true;
      object.visible = saved.visible;
    });
  }
}
