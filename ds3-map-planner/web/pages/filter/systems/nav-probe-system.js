import * as THREE from "three";

export function markNavSegmentByDownRaycast(
  ctx,
  origin,
  { raycaster = null, far = 4.0, offsetY = 0.3 } = {},
) {
  if (!ctx?.navmeshGroup || !origin) return false;
  const rc = raycaster || new THREE.Raycaster();
  const from = origin.clone();
  from.y += Number(offsetY) || 0;
  rc.set(from, new THREE.Vector3(0, -1, 0));
  rc.far = Number(far) > 0 ? Number(far) : 4.0;
  const targets = [];
  for (const navObj of ctx.navmeshGroup.children) {
    if (navObj.userData.manualEnabled === false || navObj.visible === false) continue;
    for (const seg of navObj.children) {
      if (!seg.isMesh || seg.visible === false || seg.userData?.kind !== "nav-segment") continue;
      targets.push(seg);
    }
  }
  if (targets.length === 0) return false;
  const hits = rc.intersectObjects(targets, false);
  const first = hits[0];
  if (!first?.object) return false;
  const seg = first.object;
  const path = seg.userData?.parentPath;
  const segmentIndex = Number(seg.userData?.segmentIndex);
  if (!path || !Number.isFinite(segmentIndex)) return false;
  const key = `${path}::${segmentIndex}`;
  if (ctx.navSegmentUsageStates.has(key)) return false;
  ctx.navSegmentUsageStates.set(key, true);
  ctx.requestNavVisualRefresh?.();
  return true;
}

export class NavProbeSystem {
  constructor() {
    this.active = false;
    this.raycaster = new THREE.Raycaster();
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
    markNavSegmentByDownRaycast(ctx, s.position, { raycaster: this.raycaster, far: 4.0, offsetY: 0.3 });
  }
}
