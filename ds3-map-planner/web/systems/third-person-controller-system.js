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
    this.boundMouseMove = (event) => {
      if (!this.active || !this.pointerLocked) return;
      this.mouseLook.yaw -= event.movementX * 0.0022;
      this.mouseLook.pitch -= event.movementY * 0.0016;
      this.mouseLook.pitch = Math.max(-1.2, Math.min(0.8, this.mouseLook.pitch));
    };
    this.boundWheel = (event) => {
      if (!this.active) return;
      this.desiredCamDistance += event.deltaY * 0.003;
      this.desiredCamDistance = Math.max(2.0, Math.min(12.0, this.desiredCamDistance));
    };
    this.boundPointerLockChange = () => { this.pointerLocked = document.pointerLockElement === this.domEl; };
    this.boundDomPointerDown = (event) => {
      if (!this.active || !this.domEl) return;
      if (event.button !== 0) return;
      if (document.pointerLockElement === this.domEl) return;
      this.domEl.requestPointerLock?.();
    };
    this.domEl = null;
  }

  enter(ctx) {
    this.active = true;
    this.domEl = ctx.renderer?.domElement || null;
    window.addEventListener("mousemove", this.boundMouseMove);
    window.addEventListener("wheel", this.boundWheel, { passive: true });
    document.addEventListener("pointerlockchange", this.boundPointerLockChange);
    if (this.domEl) this.domEl.addEventListener("pointerdown", this.boundDomPointerDown);
    if (ctx.controls) ctx.controls.enabled = false;
  }

  exit(ctx) {
    this.active = false;
    window.removeEventListener("mousemove", this.boundMouseMove);
    window.removeEventListener("wheel", this.boundWheel);
    document.removeEventListener("pointerlockchange", this.boundPointerLockChange);
    if (this.domEl) this.domEl.removeEventListener("pointerdown", this.boundDomPointerDown);
    if (document.pointerLockElement === this.domEl) document.exitPointerLock?.();
    this.keys.clear();
    this.pointerLocked = false;
    if (ctx.controls) ctx.controls.enabled = true;
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
    const s = ctx.runtime.physicsState;
    s.verticalVelocity -= GRAVITY * dt;
    if (s.grounded && this.keys.has("Space")) {
      s.verticalVelocity = JUMP_SPEED;
      s.grounded = false;
    }

    const forward = new THREE.Vector3(
      Math.sin(this.mouseLook.yaw) * Math.cos(this.mouseLook.pitch),
      0,
      Math.cos(this.mouseLook.yaw) * Math.cos(this.mouseLook.pitch)
    ).normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();
    if (this.keys.has("KeyW")) move.add(forward);
    if (this.keys.has("KeyS")) move.sub(forward);
    if (this.keys.has("KeyD")) move.add(right);
    if (this.keys.has("KeyA")) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize();
      const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      move.multiplyScalar(MOVE_SPEED * (sprint ? SPRINT_MULTIPLIER : 1.0) * dt);
    }
    s.requestedMove.copy(move);
    s.horizontalSpeed = Math.hypot(move.x, move.z) / Math.max(dt, 1e-5);

    const center = s.position.clone();
    const lookDir = new THREE.Vector3(
      Math.sin(this.mouseLook.yaw) * Math.cos(this.mouseLook.pitch),
      Math.sin(this.mouseLook.pitch),
      Math.cos(this.mouseLook.yaw) * Math.cos(this.mouseLook.pitch)
    ).normalize();
    const desiredCamPos = center.clone().addScaledVector(lookDir, -this.desiredCamDistance).add(new THREE.Vector3(0, CAM_HEIGHT, 0));
    const camPos = this.adjustCameraForObstruction(ctx, center, desiredCamPos);
    ctx.camera.position.lerp(camPos, 0.12);
    ctx.controls.target.lerp(center, 0.18);
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
    const hits = this.raycaster.intersectObjects(ctx.collisionGroup.children, true);
    this.raycaster.far = prevFar;
    const first = hits.find((h) => {
      if (!h.object || !h.object.isMesh) return false;
      let cur = h.object;
      while (cur) {
        if (cur.visible === false) return false;
        cur = cur.parent;
      }
      return true;
    });
    if (!first) return desiredCamPos;
    const safeDist = Math.max(1.1, first.distance - 0.18);
    return targetPos.clone().addScaledVector(dir, safeDist);
  }
}
