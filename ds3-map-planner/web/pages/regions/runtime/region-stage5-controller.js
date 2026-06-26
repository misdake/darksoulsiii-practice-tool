import * as THREE from "three";
import { PhysicsSystem } from "../../../shared/physics-system.js";
import { ThirdPersonControllerSystem } from "../../../shared/third-person-controller-system.js";

const FREE_CAMERA_SPEED = 32;
const FREE_CAMERA_SPRINT = 3.2;
const PLAYER_PLACE_HEIGHT = 1.2;

export class RegionStage5Controller {
  constructor({ renderer, scene, camera, collisionGroup, runtime, setStatus }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.collisionGroup = collisionGroup;
    this.runtime = runtime;
    this.setStatus = setStatus;
    this.mode = "free";
    this.active = false;
    this.playerReady = false;
    this.freeKeys = new Set();
    this.raycaster = new THREE.Raycaster();
    this.pointerDown = false;
    this.pointerButton = -1;
    this.lastX = 0;
    this.lastY = 0;
    this.dragMoved = false;
    this.physics = new PhysicsSystem();
    this.thirdPerson = new ThirdPersonControllerSystem();
    this.controls = {
      enabled: true,
      target: camera.userData.target || new THREE.Vector3(),
    };
    this.camera.userData.target = this.controls.target;
  }

  get paused() {
    return this.mode !== "thirdPerson" || this.thirdPerson.flightPaused;
  }

  get snapshot() {
    return {
      mode: this.mode,
      playerReady: this.playerReady,
      paused: this.paused,
      position: this.runtime.physicsState.position,
    };
  }

  get playerMesh() {
    return this.physics.playerDebugMesh;
  }

  context() {
    return {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      controls: this.controls,
      collisionGroup: this.collisionGroup,
      runtime: this.runtime,
      setStatus: this.setStatus,
    };
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.mode = "free";
    this.physics.enter(this.context());
    this.exitThirdPerson();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.exitThirdPerson();
    this.freeKeys.clear();
    this.physics.exit(this.context());
  }

  rebuildPhysics() {
    if (!this.active) return;
    this.physics.ensureInitialized().then(() => {
      this.physics.rebuildFromCollision(this.context());
      this.physics.ensurePlayerBody(this.context());
    });
  }

  setMode(mode) {
    const nextMode = mode === "thirdPerson" ? "thirdPerson" : "free";
    if (nextMode === this.mode) return;
    if (nextMode === "thirdPerson" && !this.playerReady) {
      this.setStatus?.("Click collision in Stage 5 free camera first.", true);
      return;
    }
    this.mode = nextMode;
    if (this.mode === "thirdPerson") {
      this.thirdPerson.enter(this.context());
    } else {
      this.exitThirdPerson();
    }
  }

  toggleMode() {
    this.setMode(this.mode === "thirdPerson" ? "free" : "thirdPerson");
  }

  exitThirdPerson() {
    if (this.thirdPerson.active) {
      this.thirdPerson.exit(this.context());
    }
    this.thirdPerson.clearKeys?.();
    this.runtime.physicsState.requestedMove.set(0, 0, 0);
  }

  update(dt) {
    if (!this.active) return;
    if (this.mode === "thirdPerson") {
      this.thirdPerson.update(this.context(), dt);
      this.physics.update(this.context(), dt);
      this.controls.target.copy(this.runtime.physicsState.position);
      this.camera.lookAt(this.controls.target);
      return;
    }
    this.updateFreeCamera(dt);
  }

  handlers() {
    return {
      onPointerDown: (payload) => this.pointerDownEvent(payload),
      onPointerMove: (payload) => this.pointerMoveEvent(payload),
      onPointerUp: (payload) => this.pointerUpEvent(payload),
      onWheel: ({ event }) => this.wheelEvent(event),
      onKeyDown: (event) => this.keyEvent(event, true),
      onKeyUp: (event) => this.keyEvent(event, false),
    };
  }

  pointerDownEvent({ event }) {
    event.preventDefault();
    if (this.mode === "thirdPerson") {
      this.thirdPerson.onPointerDown(this.context(), event);
      return;
    }
    this.pointerDown = true;
    this.pointerButton = event.button;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.dragMoved = false;
  }

  pointerMoveEvent({ event, viewport }) {
    if (this.mode === "thirdPerson") {
      this.thirdPerson.onPointerMove(this.context(), event);
      return;
    }
    if (!this.pointerDown) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (dx * dx + dy * dy > 0) {
      this.dragMoved = true;
    }
    if (!dx && !dy) return;
    event.preventDefault();
    if (this.pointerButton === 2) {
      this.panFreeCamera(dx, dy, viewport.height);
    } else {
      this.rotateFreeCamera(dx, dy);
    }
  }

  pointerUpEvent({ ndc, event }) {
    if (this.mode === "thirdPerson") return;
    const shouldPick =
      this.pointerDown &&
      !this.dragMoved &&
      this.pointerButton === 0 &&
      event.button === 0;
    this.pointerDown = false;
    this.pointerButton = -1;
    if (!shouldPick) return;
    event.preventDefault();
    this.placePlayerByCollisionPick(ndc);
  }

  wheelEvent(event) {
    event.preventDefault();
    if (this.mode === "thirdPerson") {
      this.thirdPerson.onWheel(this.context(), event);
      return;
    }
    const factor = event.deltaY > 0 ? 1.12 : 0.88;
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const distance = this.camera.position.distanceTo(this.controls.target);
    const nextDistance = Math.max(2, Math.min(220, distance * factor));
    this.camera.position
      .copy(this.controls.target)
      .addScaledVector(direction, -nextDistance);
    this.camera.lookAt(this.controls.target);
  }

  keyEvent(event, down) {
    if (event.code === "KeyF" && down) {
      event.preventDefault();
      this.toggleMode();
      return;
    }
    if (this.mode === "thirdPerson") {
      this.thirdPerson.setKeyState(event.code, down);
      return;
    }
    if (down) this.freeKeys.add(event.code);
    else this.freeKeys.delete(event.code);
  }

  placePlayerByCollisionPick(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster
      .intersectObjects(this.collisionGroup.children, true)
      .find((item) => item.object?.isMesh && isHierarchyPhysicsEnabled(item.object));
    if (!hit?.point) {
      this.setStatus?.("No collision hit under cursor.", true);
      return false;
    }
    const target = hit.point.clone().add(new THREE.Vector3(0, PLAYER_PLACE_HEIGHT, 0));
    if (!this.physics.setPlayerPosition(this.context(), target)) {
      this.setStatus?.("Physics player is not ready yet.", true);
      return false;
    }
    this.playerReady = true;
    this.controls.target.copy(target);
    this.setStatus?.(
      `Placed player: ${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}`,
    );
    return true;
  }

  updateFreeCamera(dt) {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0))
      .normalize();
    const move = new THREE.Vector3();
    if (this.freeKeys.has("KeyW")) move.add(forward);
    if (this.freeKeys.has("KeyS")) move.sub(forward);
    if (this.freeKeys.has("KeyD")) move.add(right);
    if (this.freeKeys.has("KeyA")) move.sub(right);
    if (this.freeKeys.has("Space")) move.y += 1;
    if (this.freeKeys.has("ShiftLeft") || this.freeKeys.has("ShiftRight")) {
      move.y -= 1;
    }
    if (move.lengthSq() <= 0) return;
    move.normalize();
    const sprint =
      this.freeKeys.has("ControlLeft") || this.freeKeys.has("ControlRight");
    move.multiplyScalar(
      (sprint ? FREE_CAMERA_SPEED * FREE_CAMERA_SPRINT : FREE_CAMERA_SPEED) *
        dt,
    );
    this.camera.position.add(move);
    this.controls.target.add(move);
    this.camera.lookAt(this.controls.target);
  }

  rotateFreeCamera(dx, dy) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dx * 0.006;
    spherical.phi = Math.max(
      0.08,
      Math.min(Math.PI - 0.08, spherical.phi - dy * 0.004),
    );
    this.camera.position
      .copy(this.controls.target)
      .add(new THREE.Vector3().setFromSpherical(spherical));
    this.camera.lookAt(this.controls.target);
  }

  panFreeCamera(dx, dy, viewportHeight) {
    const distance = Math.max(
      1,
      this.camera.position.distanceTo(this.controls.target),
    );
    const unitsPerPixel = distance / Math.max(1, viewportHeight);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const delta = right
      .multiplyScalar(-dx * unitsPerPixel)
      .add(up.multiplyScalar(dy * unitsPerPixel));
    this.camera.position.add(delta);
    this.controls.target.add(delta);
    this.camera.lookAt(this.controls.target);
  }
}

function isHierarchyPhysicsEnabled(object) {
  let current = object;
  while (current) {
    if (current.userData?.manualEnabled === false) return false;
    current = current.parent;
  }
  return true;
}
