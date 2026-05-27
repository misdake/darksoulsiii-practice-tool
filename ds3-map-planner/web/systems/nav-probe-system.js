import * as THREE from "three";

export class NavProbeSystem {
  constructor() {
    this.active = false;
    this.raycaster = new THREE.Raycaster();
    this.down = new THREE.Vector3(0, -1, 0);
  }

  enter(_ctx) {
    this.active = true;
  }

  exit(_ctx) {
    this.active = false;
  }

  update(ctx, _dt) {
    if (!this.active) return;
    if (!ctx.navmeshGroup) return;
    const s = ctx.runtime.physicsState;
    if (!s.grounded) return;
    const origin = s.position.clone();
    origin.y += 0.3;
    this.raycaster.set(origin, this.down);
    this.raycaster.far = 4.0;
    const targets = [];
    for (const navObj of ctx.navmeshGroup.children) {
      if (navObj.userData.manualEnabled === false) continue;
      for (const seg of navObj.children) {
        if (!seg.isMesh || seg.userData?.kind !== "nav-segment") continue;
        targets.push(seg);
      }
    }
    if (targets.length === 0) return;
    const hits = this.raycaster.intersectObjects(targets, false);
    const first = hits[0];
    if (!first?.object) return;
    const seg = first.object;
    const path = seg.userData?.parentPath;
    const segmentIndex = Number(seg.userData?.segmentIndex);
    if (!path || !Number.isFinite(segmentIndex)) return;
    const key = `${path}::${segmentIndex}`;
    if (!ctx.navSegmentUsageStates.has(key)) {
      ctx.navSegmentUsageStates.set(key, true);
      ctx.requestNavVisualRefresh?.();
    }
  }
}
