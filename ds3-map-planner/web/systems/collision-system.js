export class CollisionSystem {
  constructor() {
    this.group = null;
    this.stage = {
      visible: true,
      opacity: 0.5,
      selectable: false,
    };
  }

  setGroup(group) {
    this.group = group || null;
  }

  getGroup() {
    return this.group;
  }

  setStage(stagePatch) {
    this.stage = { ...this.stage, ...stagePatch };
  }

  applyVisibility(showCollisionChecked) {
    if (!this.group) return;
    this.group.visible = this.stage.visible;
    for (const child of this.group.children) {
      child.visible = showCollisionChecked && child.userData.manualEnabled !== false;
    }
  }

  applyOpacity() {
    if (!this.group) return;
    const effectiveOpacity = Math.min(Number(this.stage.opacity), 0.9);
    this.group.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      obj.material.opacity = effectiveOpacity;
      obj.material.transparent = true;
      obj.material.depthWrite = true;
      obj.material.needsUpdate = true;
    });
  }

  applySelectionVisual(selectedTarget, baseColor, highlightColor) {
    if (!this.group) return;
    for (const child of this.group.children) {
      const isSelected = this.stage.selectable && selectedTarget === child;
      const color = isSelected ? highlightColor : baseColor;
      child.traverse((obj) => {
        if (!obj.isMesh || !obj.material || !obj.material.color) return;
        obj.material.color.setHex(color);
      });
    }
  }
}
