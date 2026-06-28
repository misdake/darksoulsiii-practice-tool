import * as THREE from "three";

const FREE_CAMERA_SPEED = 32;
const FAST_CAMERA_SPEED = 96;
const RIGHT_ZOOM_IN = 0.88;
const RIGHT_ZOOM_OUT = 1.12;
const POINTER_ROTATION_SCALE = 0.002;
const MIN_POLAR_ANGLE = 0.05;
const MAX_POLAR_ANGLE = Math.PI - 0.05;

export class RegionFreeCamera {
  constructor(camera) {
    this.camera = camera;
    this.keys = new Set();
  }

  focus(center, region) {
    this.camera.position.set(center.x + 25, region.ymax + 20, center.z + 25);
    this.camera.lookAt(center.x, center.y, center.z);
    this.camera.userData.target.set(center.x, center.y, center.z);
  }

  focusBounds(center, maxExtent) {
    const radius = Math.max(1, Number(maxExtent) * 0.5 || 1);
    const verticalHalfFov = THREE.MathUtils.degToRad(this.camera.fov) * 0.5;
    const horizontalHalfFov = Math.atan(
      Math.tan(verticalHalfFov) * Math.max(1e-6, this.camera.aspect),
    );
    const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
    const distance = Math.max(20, (radius / Math.sin(limitingHalfFov)) * 1.15);
    const direction = new THREE.Vector3(1, 0.8, 1).normalize();
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.lookAt(center.x, center.y, center.z);
    this.camera.userData.target.copy(center);
    this.camera.far = Math.max(1000, distance + radius * 4);
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    const delta = this.getMoveDelta();
    if (!delta.lengthSq()) return;

    const speed = this.keys.has("ControlLeft")
      ? FAST_CAMERA_SPEED
      : FREE_CAMERA_SPEED;
    delta.normalize().multiplyScalar(speed * dt);
    this.camera.position.add(delta);
    this.camera.userData.target.add(delta);
  }

  setKey(code, pressed) {
    if (pressed) this.keys.add(code);
    else this.keys.delete(code);
  }

  rotate(movementX, movementY) {
    const target = this.camera.userData.target;
    const offset = this.camera.position.clone().sub(target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= movementX * POINTER_ROTATION_SCALE;
    spherical.phi = Math.max(
      MIN_POLAR_ANGLE,
      Math.min(
        MAX_POLAR_ANGLE,
        spherical.phi - movementY * POINTER_ROTATION_SCALE,
      ),
    );
    spherical.makeSafe();
    this.camera.position
      .copy(target)
      .add(new THREE.Vector3().setFromSpherical(spherical));
    this.camera.lookAt(target);
  }

  pan(movementX, movementY, viewportHeight) {
    const distance = this.camera.position.distanceTo(
      this.camera.userData.target,
    );
    const worldPerPixel =
      (2 *
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) *
        distance) /
      Math.max(1, viewportHeight);
    const right = new THREE.Vector3().setFromMatrixColumn(
      this.camera.matrix,
      0,
    );
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const delta = right
      .multiplyScalar(-movementX * worldPerPixel)
      .add(up.multiplyScalar(movementY * worldPerPixel));

    this.camera.position.add(delta);
    this.camera.userData.target.add(delta);
  }

  zoom(deltaY) {
    const factor = deltaY > 0 ? RIGHT_ZOOM_OUT : RIGHT_ZOOM_IN;
    const distance = Math.max(
      2,
      this.camera.position.distanceTo(this.camera.userData.target) * factor,
    );
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    this.camera.position
      .copy(this.camera.userData.target)
      .addScaledVector(direction, -distance);
  }

  getMoveDelta() {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    const right = new THREE.Vector3()
      .crossVectors(forward, THREE.Object3D.DEFAULT_UP)
      .normalize();
    const delta = new THREE.Vector3();

    if (this.keys.has("KeyW")) delta.add(forward);
    if (this.keys.has("KeyS")) delta.sub(forward);
    if (this.keys.has("KeyD")) delta.add(right);
    if (this.keys.has("KeyA")) delta.sub(right);
    if (this.keys.has("Space")) delta.y += 1;
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) {
      delta.y -= 1;
    }

    return delta;
  }
}
