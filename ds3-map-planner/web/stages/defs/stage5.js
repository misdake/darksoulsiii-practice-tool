import * as THREE from "three";
import { markNavSegmentByDownRaycast } from "../../systems/nav-probe-system.js";

const CAMERA_FAR = { free: 10000, thirdPerson: 1000 };
const FREE_CAMERA_SPEED = 32;
const FREE_CAMERA_SPRINT = 3.2;

export function createStage5Definition() {
  let cameraMode = "thirdPerson";
  const freeKeys = new Set();
  const raycaster = new THREE.Raycaster();
  let middlePickHeld = false;
  let rightPickPending = false;
  let rightDownX = 0;
  let rightDownY = 0;

  function modeButtonText() {
    return cameraMode === "thirdPerson" ? "Switch To Free Camera (F)" : "Enter Third-Person (F)";
  }

  function updateHint(ctx) {
    if (cameraMode === "thirdPerson") {
      ctx.setStatus("third-person mode\nmove: WASD, jump: Space, sprint: Shift\ncamera: mouse after click scene\ntoggle: F");
      return;
    }
    ctx.setStatus("free camera mode\nmove xz: WASD, move y: Space/Shift\norbit: mouse drag, zoom: wheel\nclick ground: place character\ntoggle: F");
  }

  function applyCameraMode(ctx, mode, silent = false) {
    cameraMode = mode === "free" ? "free" : "thirdPerson";
    if (cameraMode === "thirdPerson") {
      if (!ctx.systems.physics.active) ctx.systems.physics.enter(ctx);
      if (!ctx.systems.thirdPerson.active) ctx.systems.thirdPerson.enter(ctx);
    } else {
      ctx.systems.thirdPerson.clearKeys?.();
      if (ctx.systems.thirdPerson.active) ctx.systems.thirdPerson.exit(ctx);
      if (ctx.controls) ctx.controls.enabled = true;
    }
    ctx.camera.far = cameraMode === "thirdPerson" ? CAMERA_FAR.thirdPerson : CAMERA_FAR.free;
    ctx.camera.updateProjectionMatrix();
    ctx.ui.setCameraModeButton({ visible: true, text: modeButtonText() });
    if (!silent) updateHint(ctx);
  }

  function toggleCameraMode(ctx) {
    applyCameraMode(ctx, cameraMode === "thirdPerson" ? "free" : "thirdPerson", false);
  }

  function updateFreeCamera(ctx, dt) {
    if (cameraMode !== "free") return;
    const forward = new THREE.Vector3();
    ctx.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const move = new THREE.Vector3();
    if (freeKeys.has("KeyW")) move.add(forward);
    if (freeKeys.has("KeyS")) move.sub(forward);
    if (freeKeys.has("KeyD")) move.add(right);
    if (freeKeys.has("KeyA")) move.sub(right);
    if (freeKeys.has("Space")) move.add(up);
    if (freeKeys.has("ShiftLeft") || freeKeys.has("ShiftRight")) move.sub(up);
    if (move.lengthSq() <= 0) return;
    move.normalize();
    const sprint = freeKeys.has("ControlLeft") || freeKeys.has("ControlRight");
    move.multiplyScalar((sprint ? FREE_CAMERA_SPEED * FREE_CAMERA_SPRINT : FREE_CAMERA_SPEED) * dt);
    ctx.camera.position.add(move);
    ctx.controls.target.add(move);
  }

  function placePlayerByGroundClick(ctx, event) {
    if (cameraMode !== "free") return false;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const mouseNdc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.far = Infinity;
    raycaster.setFromCamera(mouseNdc, ctx.camera);
    const visibleCollisionObjects = [];
    if (ctx.collisionGroup?.visible) {
      for (const col of ctx.collisionGroup.children) {
        if (col.visible === false || col.userData?.manualEnabled === false) continue;
        visibleCollisionObjects.push(col);
      }
    }
    if (visibleCollisionObjects.length === 0) return false;
    const hits = raycaster.intersectObjects(visibleCollisionObjects, true);
    const first = hits.find((h) => h?.object?.isMesh && h.object.visible !== false);
    if (!first?.point) return false;
    const target = first.point.clone().add(new THREE.Vector3(0, 1.2, 0));
    ctx.systems.physics.setPlayerPosition(ctx, target);
    ctx.setStatus(`placed player: ${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}`, false, 1400);
    return true;
  }

  function markNavByMiddlePick(ctx, event) {
    if (cameraMode !== "free") return false;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const mouseNdc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.far = Infinity;
    raycaster.setFromCamera(mouseNdc, ctx.camera);
    const targets = [];
    if (ctx.collisionGroup?.visible) {
      for (const col of ctx.collisionGroup.children) {
        if (col.userData?.manualEnabled === false || col.visible === false) continue;
        targets.push(col);
      }
    }
    if (targets.length === 0) return false;
    const hits = raycaster.intersectObjects(targets, true);
    const first = hits.find((h) => h?.object?.isMesh && h.object.visible !== false);
    if (!first?.point) return false;
    return markNavSegmentByDownRaycast(ctx, first.point, { far: 8.0, offsetY: 0.3 });
  }

  function unmarkNavByRightPick(ctx, event) {
    if (cameraMode !== "free" || !ctx.navmeshGroup) return false;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const mouseNdc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.far = Infinity;
    raycaster.setFromCamera(mouseNdc, ctx.camera);
    const targets = [];
    for (const navObj of ctx.navmeshGroup.children) {
      if (navObj.userData.manualEnabled === false || navObj.visible === false) continue;
      for (const seg of navObj.children) {
        if (!seg.isMesh || seg.visible === false || seg.userData?.kind !== "nav-segment") continue;
        targets.push(seg);
      }
    }
    if (targets.length === 0) return false;
    const hits = raycaster.intersectObjects(targets, false);
    const first = hits[0];
    if (!first?.object) return false;
    const path = first.object.userData?.parentPath;
    const segmentIndex = Number(first.object.userData?.segmentIndex);
    if (!path || !Number.isFinite(segmentIndex)) return false;
    const key = `${path}::${segmentIndex}`;
    if (!ctx.navSegmentUsageStates.has(key)) return false;
    ctx.navSegmentUsageStates.delete(key);
    ctx.requestNavVisualRefresh?.();
    return true;
  }

  return {
    name: "Terrain Adventure",
    enter(ctx) {
      ctx.systems.collision.setStage({ visible: true, opacity: 0.7, selectable: false });
      ctx.systems.nav.setStage({
        visible: true,
        useMerged: false,
        hideDeleted: false,
        allowSegmentHighlight: false,
        allowNavObjHighlight: false,
      });
      ctx.ui.setSegmentToolsEnabled(false);
      ctx.systems.physics.enter(ctx);
      ctx.systems.navProbe.enter(ctx);
      ctx.ui.setCameraModeButton({ visible: true, text: modeButtonText() });
      applyCameraMode(ctx, "free", true);
      updateHint(ctx);
    },
    exit(ctx) {
      ctx.ui.setCameraModeButton({ visible: false, text: "Enter Third-Person (F)" });
      ctx.systems.navProbe.exit(ctx);
      ctx.systems.thirdPerson.clearKeys?.();
      if (ctx.systems.thirdPerson.active) ctx.systems.thirdPerson.exit(ctx);
      ctx.systems.physics.exit(ctx);
      ctx.camera.far = CAMERA_FAR.free;
      ctx.camera.updateProjectionMatrix();
      freeKeys.clear();
      middlePickHeld = false;
      rightPickPending = false;
    },
    onSceneReload(ctx) {
      ctx.systems.physics.rebuildFromCollision(ctx);
      ctx.systems.physics.ensurePlayerBody(ctx);
    },
    handleToggleCameraMode(ctx) {
      toggleCameraMode(ctx);
    },
    update(ctx, dt) {
      updateFreeCamera(ctx, dt);
    },
    onPointerClick(ctx, event) {
      return placePlayerByGroundClick(ctx, event);
    },
    onPointerDown(ctx, event) {
      if (event.button === 1) {
        middlePickHeld = true;
        return markNavByMiddlePick(ctx, event);
      }
      if (event.button === 2) {
        rightPickPending = true;
        rightDownX = event.clientX;
        rightDownY = event.clientY;
        return true;
      }
      return false;
    },
    onPointerMove(ctx, event) {
      if (rightPickPending) {
        const dx = event.clientX - rightDownX;
        const dy = event.clientY - rightDownY;
        if (dx * dx + dy * dy > 16) rightPickPending = false;
      }
      if (!middlePickHeld) return false;
      return markNavByMiddlePick(ctx, event);
    },
    onPointerUp(ctx, event) {
      if (event.button === 1) {
        middlePickHeld = false;
        return false;
      }
      if (event.button === 2) {
        const shouldPick = rightPickPending;
        rightPickPending = false;
        if (!shouldPick) return true;
        return unmarkNavByRightPick(ctx, event);
      }
      return false;
    },
    onKeyDown(ctx, event) {
      freeKeys.add(event.code);
      if (cameraMode === "thirdPerson") ctx.systems.thirdPerson.setKeyState(event.code, true);
      if (event.code === "Space" && cameraMode === "free") return true;
      if (event.code === "KeyF") {
        toggleCameraMode(ctx);
        return true;
      }
      return false;
    },
    onKeyUp(ctx, event) {
      freeKeys.delete(event.code);
      if (cameraMode === "thirdPerson") ctx.systems.thirdPerson.setKeyState(event.code, false);
      return false;
    },
    resolvePick: (_hit, _node) => null,
    resolveNavMenuSelection: (_navObj) => null,
  };
}
