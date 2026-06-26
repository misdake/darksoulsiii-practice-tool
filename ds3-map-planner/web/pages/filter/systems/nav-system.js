import * as THREE from "three";

export class NavSystem {
  constructor() {
    this.group = null;
    this.stage = {
      visible: true,
      useMerged: false,
      hideDeleted: false,
      allowSegmentHighlight: false,
      allowNavObjHighlight: false,
      selectedOnly: false,
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

  applyVisibility(showNavmeshChecked) {
    if (!this.group) return;
    this.group.visible = this.stage.visible && showNavmeshChecked;
  }

  applyVisuals({
    selectedTarget,
    getSegmentState,
    getSegmentUsage,
    navStateColors,
    highlightColor,
  }) {
    if (!this.group) return;
    this.group.children.forEach((navObj) => {
      const navEnabled = navObj.userData.manualEnabled !== false;
      const merged = navObj.userData.mergedMesh || null;
      const navObjSelected = this.stage.allowNavObjHighlight && selectedTarget === navObj;
      let r = 0;
      let g = 0;
      let b = 0;
      let cnt = 0;
      navObj.children.forEach((seg) => {
        if (!seg.isMesh || seg.userData.kind !== "nav-segment") return;
        const state = getSegmentState(navObj.name, seg.userData.segmentIndex);
        const baseColor = navStateColors[state] ?? navStateColors.unset;
        const color = new THREE.Color(baseColor);
        if (getSegmentUsage(navObj.name, seg.userData.segmentIndex)) {
          color.lerp(new THREE.Color(0x4fc3f7), 0.6);
        }
        if (this.stage.allowSegmentHighlight && selectedTarget === seg) {
          color.lerp(new THREE.Color(highlightColor), 0.55);
        }
        seg.material.color.copy(color);
        if (!navEnabled || this.stage.useMerged) {
          seg.visible = false;
        } else if (this.stage.selectedOnly && !getSegmentUsage(navObj.name, seg.userData.segmentIndex)) {
          seg.visible = false;
        } else if (this.stage.hideDeleted && state === "delete") {
          seg.visible = false;
        } else {
          seg.visible = true;
        }
        r += color.r;
        g += color.g;
        b += color.b;
        cnt++;
      });
      if (merged && merged.isMesh) {
        const avg = cnt > 0
          ? new THREE.Color(r / cnt, g / cnt, b / cnt)
          : new THREE.Color(navStateColors.unset);
        if (navObjSelected) avg.lerp(new THREE.Color(highlightColor), 0.35);
        merged.material.color.copy(avg);
        merged.visible = navEnabled && this.stage.useMerged;
      }
    });
  }
}
