import * as THREE from "three";
import { markNavSegmentByDownRaycast } from "../../systems/nav-probe-system.js";

const CAMERA_FAR = { free: 10000, thirdPerson: 1000 };
const FREE_CAMERA_SPEED = 32;
const FREE_CAMERA_SPRINT = 3.2;

export function createStage3MarkNavDefinition() {
  let cameraMode = "thirdPerson";
  const freeKeys = new Set();
  const raycaster = new THREE.Raycaster();
  let middlePickHeld = false;
  let rightPickPending = false;
  let rightDownX = 0;
  let rightDownY = 0;
  let collisionHidden = false;
  let collisionOpacity = 0.7;

  function applyCollisionHidden(ctx, hidden) {
    collisionHidden = Boolean(hidden);
    ctx.systems.collision.setStage({ visible: !collisionHidden });
    ctx.requestCollisionVisibilityRefresh?.();
    ctx.ui.setStage3CollisionHidden?.(collisionHidden);
  }

  function applyCollisionOpacity(ctx, opacity) {
    collisionOpacity = Math.max(0, Math.min(1, Number(opacity) || 0));
    ctx.systems.collision.setStage({ opacity: collisionOpacity });
    ctx.systems.collision.applyOpacity();
    ctx.ui.setStage3CollisionOpacity?.(collisionOpacity);
  }

  function modeButtonText() {
    return cameraMode === "thirdPerson"
      ? "Switch To Free Camera (F)"
      : "Enter Third-Person (F)";
  }

  function updateHint(ctx) {
    if (cameraMode === "thirdPerson") {
      ctx.setStatus(
        "third-person mode\nmove: WASD, jump: Space, sprint: Shift\ncamera: mouse after click scene\ntoggle: F",
      );
      return;
    }
    ctx.setStatus(
      "free camera mode\nmove xz: WASD, move y: Space/Shift\nmark nav: middle drag, unmark: right click\ntoggle: F",
    );
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
    ctx.camera.far =
      cameraMode === "thirdPerson" ? CAMERA_FAR.thirdPerson : CAMERA_FAR.free;
    ctx.camera.updateProjectionMatrix();
    ctx.ui.setCameraModeButton({ visible: true, text: modeButtonText() });
    if (!silent) updateHint(ctx);
  }

  function toggleCameraMode(ctx) {
    applyCameraMode(
      ctx,
      cameraMode === "thirdPerson" ? "free" : "thirdPerson",
      false,
    );
  }

  function updateFreeCamera(ctx, dt) {
    if (cameraMode !== "free") return;
    const forward = new THREE.Vector3();
    ctx.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0))
      .normalize();
    const move = new THREE.Vector3();
    if (freeKeys.has("KeyW")) move.add(forward);
    if (freeKeys.has("KeyS")) move.sub(forward);
    if (freeKeys.has("KeyD")) move.add(right);
    if (freeKeys.has("KeyA")) move.sub(right);
    if (freeKeys.has("Space")) move.y += 1;
    if (freeKeys.has("ShiftLeft") || freeKeys.has("ShiftRight")) move.y -= 1;
    if (move.lengthSq() <= 0) return;
    move.normalize();
    const sprint = freeKeys.has("ControlLeft") || freeKeys.has("ControlRight");
    move.multiplyScalar(
      (sprint ? FREE_CAMERA_SPEED * FREE_CAMERA_SPRINT : FREE_CAMERA_SPEED) *
        dt,
    );
    ctx.camera.position.add(move);
    ctx.controls.target.add(move);
  }

  function sceneRay(ctx, event) {
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.far = Infinity;
    raycaster.setFromCamera(mouse, ctx.camera);
  }

  function placePlayerByGroundClick(ctx, event) {
    if (cameraMode !== "free" || collisionHidden) return false;
    sceneRay(ctx, event);
    const targets = (ctx.collisionGroup?.children || []).filter(
      (x) => x.visible !== false && x.userData?.manualEnabled !== false,
    );
    const first = raycaster
      .intersectObjects(targets, true)
      .find((h) => h?.object?.isMesh && h.object.visible !== false);
    if (!first?.point) return false;
    const target = first.point.clone().add(new THREE.Vector3(0, 1.2, 0));
    ctx.systems.physics.setPlayerPosition(ctx, target);
    ctx.setStatus(
      `placed player: ${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}`,
      false,
      1400,
    );
    return true;
  }

  function markNavByMiddlePick(ctx, event) {
    if (cameraMode !== "free" || collisionHidden) return false;
    sceneRay(ctx, event);
    const targets = (ctx.collisionGroup?.children || []).filter(
      (x) => x.visible !== false && x.userData?.manualEnabled !== false,
    );
    const first = raycaster
      .intersectObjects(targets, true)
      .find((h) => h?.object?.isMesh && h.object.visible !== false);
    if (!first?.point) return false;
    return markNavSegmentByDownRaycast(ctx, first.point, {
      far: 8.0,
      offsetY: 0.3,
    });
  }

  function unmarkNavByRightPick(ctx, event) {
    if (cameraMode !== "free" || !ctx.navmeshGroup) return false;
    sceneRay(ctx, event);
    const targets = [];
    for (const navObj of ctx.navmeshGroup.children) {
      if (navObj.userData.manualEnabled === false || navObj.visible === false)
        continue;
      for (const seg of navObj.children) {
        if (
          seg.isMesh &&
          seg.visible !== false &&
          seg.userData?.kind === "nav-segment"
        )
          targets.push(seg);
      }
    }
    const first = raycaster.intersectObjects(targets, false)[0];
    const path = first?.object?.userData?.parentPath;
    const segmentIndex = Number(first?.object?.userData?.segmentIndex);
    if (!path || !Number.isFinite(segmentIndex)) return false;
    const key = `${path}::${segmentIndex}`;
    if (!ctx.navSegmentUsageStates.has(key)) return false;
    ctx.navSegmentUsageStates.delete(key);
    ctx.requestNavVisualRefresh?.();
    return true;
  }

  return {
    name: "Stage 3 Mark Nav",
    storageKey: "stage3-mark-nav",
    enter(ctx) {
      ctx.systems.collision.setStage({
        visible: !collisionHidden,
        opacity: collisionOpacity,
        selectable: false,
      });
      ctx.systems.nav.setStage({
        visible: true,
        useMerged: false,
        hideDeleted: false,
        allowSegmentHighlight: false,
        allowNavObjHighlight: false,
        selectedOnly: false,
      });
      ctx.ui.setSegmentToolsEnabled(false);
      ctx.systems.physics.enter(ctx);
      ctx.systems.navProbe.enter(ctx);
      applyCameraMode(ctx, "free", true);
      ctx.ui.setStage3CollisionHidden?.(collisionHidden);
      ctx.ui.setStage3CollisionOpacity?.(collisionOpacity);
      updateHint(ctx);
    },
    exit(ctx) {
      ctx.systems.collision.setStage({ visible: true });
      ctx.requestCollisionVisibilityRefresh?.();
      ctx.ui.setCameraModeButton({ visible: false });
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
    handleCollisionHiddenChange(ctx, hidden) {
      applyCollisionHidden(ctx, hidden);
    },
    handleCollisionOpacityChange(ctx, opacity) {
      applyCollisionOpacity(ctx, opacity);
    },
    onSceneReload(ctx) {
      ctx.systems.physics.rebuildFromCollision(ctx);
      ctx.systems.physics.ensurePlayerBody(ctx);
    },
    handleToggleCameraMode: toggleCameraMode,
    update: updateFreeCamera,
    onPointerClick: placePlayerByGroundClick,
    onPointerDown(ctx, event) {
      if (cameraMode === "thirdPerson") {
        return ctx.systems.thirdPerson.onPointerDown?.(ctx, event) || false;
      }
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
      if (cameraMode === "thirdPerson") {
        return ctx.systems.thirdPerson.onPointerMove?.(ctx, event) || false;
      }
      if (rightPickPending) {
        const dx = event.clientX - rightDownX;
        const dy = event.clientY - rightDownY;
        if (dx * dx + dy * dy > 16) rightPickPending = false;
      }
      return middlePickHeld ? markNavByMiddlePick(ctx, event) : false;
    },
    onPointerUp(ctx, event) {
      if (event.button === 1) {
        middlePickHeld = false;
        return false;
      }
      if (event.button === 2) {
        const shouldPick = rightPickPending;
        rightPickPending = false;
        return shouldPick ? unmarkNavByRightPick(ctx, event) : true;
      }
      return false;
    },
    onWheel(ctx, event) {
      if (cameraMode === "thirdPerson") {
        return ctx.systems.thirdPerson.onWheel?.(ctx, event) || false;
      }
      return false;
    },
    onKeyDown(ctx, event) {
      freeKeys.add(event.code);
      if (cameraMode === "thirdPerson")
        ctx.systems.thirdPerson.setKeyState(event.code, true);
      if (event.code === "Space" && cameraMode === "free") return true;
      if (event.code === "KeyF") {
        toggleCameraMode(ctx);
        return true;
      }
      return false;
    },
    onKeyUp(ctx, event) {
      freeKeys.delete(event.code);
      if (cameraMode === "thirdPerson")
        ctx.systems.thirdPerson.setKeyState(event.code, false);
      return false;
    },
    resolvePick: () => null,
    resolveNavMenuSelection: () => null,
  };
}
