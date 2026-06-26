import * as THREE from "three";

const MOVE_SPEED = 6.6;
const JUMP_SPEED = 6.8;
const GRAVITY = 27.5;
const SPRINT_MULTIPLIER = 4.0;
const CAM_DIST = 5.8;
const CAM_HEIGHT = 2.3;

export class ThirdPersonControllerSystem {
  constructor() {
    this.active = false;
    this.keys = new Set();
    this.pointerLocked = false;
    this.mouseLook = { yaw: 0, pitch: -0.25 };
    this.desiredCamDistance = CAM_DIST;
    this.raycaster = new THREE.Raycaster();
    this.domEl = null;
    this.document = null;
  }

  get flightPaused() {
    return this.keys.has("Space");
  }

  enter(ctx) {
    this.active = true;
    this.domEl = ctx.renderer?.domElement || null;
    this.document = this.domEl?.ownerDocument || globalThis.document || null;
    if (ctx.controls) ctx.controls.enabled = false;
  }

  exit(ctx) {
    this.active = false;
    if (this.document?.pointerLockElement === this.domEl) {
      this.document.exitPointerLock?.();
    }
    this.keys.clear();
    this.pointerLocked = false;
    this.document = null;
    if (ctx.controls) ctx.controls.enabled = true;
  }

  onPointerDown(_ctx, event) {
    if (!this.active || event.button !== 0 || !this.domEl) return false;
    this.domEl.requestPointerLock?.();
    this.pointerLocked = true;
    return true;
  }

  onPointerMove(_ctx, event) {
    if (!this.active || this.document?.pointerLockElement !== this.domEl) {
      this.pointerLocked = false;
      return false;
    }
    this.pointerLocked = true;
    this.mouseLook.yaw -= event.movementX * 0.0022;
    this.mouseLook.pitch -= event.movementY * 0.0016;
    this.mouseLook.pitch = Math.max(-1.2, Math.min(0.8, this.mouseLook.pitch));
    return true;
  }

  onWheel(_ctx, event) {
    if (!this.active) return false;
    this.desiredCamDistance += event.deltaY * 0.003;
    this.desiredCamDistance = Math.max(
      2,
      Math.min(12, this.desiredCamDistance),
    );
    return true;
  }

  setKeyState(code, down) {
    if (!code) return;
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  clearKeys() {
    this.keys.clear();
  }

  update(ctx, dt) {
    if (!this.active) return;
    const state = ctx.runtime.physicsState;
    state.verticalVelocity -= GRAVITY * dt;
    if (this.keys.has("Space")) {
      state.verticalVelocity = JUMP_SPEED;
    }

    const forward = new THREE.Vector3(
      Math.sin(this.mouseLook.yaw) * Math.cos(this.mouseLook.pitch),
      0,
      Math.cos(this.mouseLook.yaw) * Math.cos(this.mouseLook.pitch),
    ).normalize();
    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0))
      .normalize();
    const move = new THREE.Vector3();
    if (this.keys.has("KeyW")) move.add(forward);
    if (this.keys.has("KeyS")) move.sub(forward);
    if (this.keys.has("KeyD")) move.add(right);
    if (this.keys.has("KeyA")) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize();
      const sprint =
        this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      move.multiplyScalar(
        MOVE_SPEED * (sprint ? SPRINT_MULTIPLIER : 1) * dt,
      );
    }
    state.requestedMove.copy(move);
    state.horizontalSpeed = Math.hypot(move.x, move.z) / Math.max(dt, 1e-5);

    const center = state.position.clone();
    const lookDir = new THREE.Vector3(
      Math.sin(this.mouseLook.yaw) * Math.cos(this.mouseLook.pitch),
      Math.sin(this.mouseLook.pitch),
      Math.cos(this.mouseLook.yaw) * Math.cos(this.mouseLook.pitch),
    ).normalize();
    const desiredCamPos = center
      .clone()
      .addScaledVector(lookDir, -this.desiredCamDistance)
      .add(new THREE.Vector3(0, CAM_HEIGHT, 0));
    const camPos = this.adjustCameraForObstruction(ctx, center, desiredCamPos);
    ctx.camera.position.lerp(camPos, 0.12);
    ctx.controls.target.lerp(center, 0.18);
    ctx.camera.lookAt(ctx.controls.target);
  }

  adjustCameraForObstruction(ctx, targetPos, desiredCamPos) {
    if (!ctx.collisionGroup) return desiredCamPos;
    const toCam = desiredCamPos.clone().sub(targetPos);
    const dist = toCam.length();
    if (dist < 1e-4) return desiredCamPos;
    const dir = toCam.clone().multiplyScalar(1 / dist);
    const prevFar = this.raycaster.far;
    this.raycaster.set(targetPos, dir);
    this.raycaster.far = dist;
    const hits = this.raycaster.intersectObjects(
      ctx.collisionGroup.children,
      true,
    );
    this.raycaster.far = prevFar;
    const first = hits.find((hit) => {
      if (!hit.object || !hit.object.isMesh) return false;
      let current = hit.object;
      while (current) {
        if (current.userData?.manualEnabled === false) return false;
        current = current.parent;
      }
      return true;
    });
    if (!first) return desiredCamPos;
    const safeDist = Math.max(1.1, first.distance - 0.18);
    return targetPos.clone().addScaledVector(dir, safeDist);
  }
}
