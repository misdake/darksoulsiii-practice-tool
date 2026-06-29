import * as THREE from "three";

export const FILTER_COLORS = Object.freeze({
  collisionBase: 0x94a3b8,
  collisionHighlight: 0xc7d2e2,
  navStates: Object.freeze({ unset: 0xef5350, selected: 0x0077b6 }),
  highlight: 0xc7d2e2,
});

const HIDE_NAV_BY_COLLISION_HF = new Set([13, 14, 15]);

export class FilterVisualController {
  constructor({
    csm,
    collisionSystem,
    navSystem,
    getCollisionGroup,
    getNavmeshGroup,
    getSelectedTarget,
    getSegmentState,
    getSegmentUsage,
    extractBlockKey,
  }) {
    this.csm = csm;
    this.collisionSystem = collisionSystem;
    this.navSystem = navSystem;
    this.getCollisionGroup = getCollisionGroup;
    this.getNavmeshGroup = getNavmeshGroup;
    this.getSelectedTarget = getSelectedTarget;
    this.getSegmentState = getSegmentState;
    this.getSegmentUsage = getSegmentUsage;
    this.extractBlockKey = extractBlockKey;
  }

  makeMaterial(kind) {
    const color =
      kind === "collision"
        ? FILTER_COLORS.collisionBase
        : FILTER_COLORS.navStates.unset;
    return this.makeStandardMaterial(color);
  }

  makeStandardMaterial(color) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.7,
      metalness: 0.0,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
    });
  }

  applyCollisionMaterial(group, opacity) {
    const effectiveOpacity = Math.min(Number(opacity), 0.9);
    group.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.material = new THREE.MeshStandardMaterial({
        color: FILTER_COLORS.collisionBase,
        roughness: 0.7,
        metalness: 0.0,
        side: THREE.DoubleSide,
        shadowSide: THREE.DoubleSide,
        opacity: effectiveOpacity,
        transparent: true,
        depthWrite: true,
      });
      this.csm.setupMaterial(obj.material);
    });
  }

  applyNavVisuals() {
    this.navSystem.applyVisuals({
      selectedTarget: this.getSelectedTarget(),
      getSegmentState: this.getSegmentState,
      getSegmentUsage: this.getSegmentUsage,
      navStateColors: FILTER_COLORS.navStates,
      highlightColor: FILTER_COLORS.highlight,
    });
  }

  applyCollisionVisuals() {
    this.collisionSystem.applySelectionVisual(
      this.getSelectedTarget(),
      FILTER_COLORS.collisionBase,
      FILTER_COLORS.collisionHighlight,
    );
  }

  applyCollisionVisibility() {
    this.collisionSystem.applyVisibility(true);
  }

  applyDefaultVisibilityRules(defaultHitFilterIds = [8]) {
    const collisionGroup = this.getCollisionGroup();
    const navmeshGroup = this.getNavmeshGroup();
    if (!collisionGroup || !navmeshGroup) return;

    const defaultSet = new Set(
      (defaultHitFilterIds || []).map((value) => Number(value)),
    );
    const forceHideNavKeys = new Set();

    for (const child of collisionGroup.children) {
      const hitFilterId = Number(child.userData?.meta?.msbHitFilterId ?? 255);
      child.userData.manualEnabled = defaultSet.has(hitFilterId);
      const triangleCount = Number(child.userData?.triangleCount || 0);
      const shouldHideRelatedNav =
        triangleCount <= 2 || HIDE_NAV_BY_COLLISION_HF.has(hitFilterId);
      if (!shouldHideRelatedNav) continue;
      const key = this.extractBlockKey(child.name);
      if (key) forceHideNavKeys.add(key);
    }

    for (const child of navmeshGroup.children) {
      const key = this.extractBlockKey(child.name);
      child.userData.manualEnabled = key ? !forceHideNavKeys.has(key) : true;
    }
  }
}
