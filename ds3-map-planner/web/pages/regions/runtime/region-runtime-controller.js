import * as THREE from "three";
import {
  createObjParser,
} from "../../../shared/map-runtime.js";
import { PLAYER_CAPSULE_FOOT_OFFSET } from "../../../shared/physics-system.js";
import { RegionShotPlanSystem } from "../planning/region-shot-plan-system.js";
import {
  disposeRegionAssetTargets,
  RegionAssetLoader,
} from "../assets/region-asset-loader.js";
import { RegionOverlayController } from "../overlay/region-overlay-controller.js";
import { RegionRenderController } from "./region-render-controller.js";
import {
  createRegionLeftCamera,
  createRegionRightCamera,
  createRegionScene,
  RegionSceneController,
} from "./region-scene-controller.js";
import { RegionTestController } from "./region-test-controller.js";
import { RegionViewportController } from "../viewport/region-viewport-controller.js";

export class RegionRuntimeController {
  constructor({ window, document, host, setStatus, onFrameGamePosition }) {
    this.window = window;
    this.document = document;
    this.host = host;
    this.setStatus = setStatus;
    this.runtime = {
      physicsState: {
        position: new THREE.Vector3(0, 0, 0),
        requestedMove: new THREE.Vector3(),
        verticalVelocity: 0,
        grounded: false,
        horizontalSpeed: 0,
      },
    };

    this.renderer = createRegionRenderer({ window, host });
    this.scene = createRegionScene();
    this.leftScene = createRegionScene();

    this.overlay = new RegionOverlayController(this.scene);
    this.overlay.setCameraPlanVisible(false);
    this.navGroup = new THREE.Group();
    this.collisionGroup = new THREE.Group();
    this.leftNavGroup = new THREE.Group();
    this.leftCollisionGroup = new THREE.Group();
    this.collisionVisible = true;
    this.collisionOpacity = 0.25;
    this.navmeshOpacity = 1;
    this.stage4Mode = "regions";
    this.clipRegions = true;
    this.recordMissingPoints = false;
    this.stage4FilterRegion = null;
    this.outdoorRegionEnabled = true;
    this.scene.add(this.navGroup, this.collisionGroup);
    this.leftScene.add(this.leftNavGroup, this.leftCollisionGroup);

    this.regionScene = new RegionSceneController({
      overlayScene: this.scene,
      mapScene: this.leftScene,
      navGroup: this.navGroup,
      collisionGroup: this.collisionGroup,
    });
    this.leftCamera = createRegionLeftCamera();
    this.rightCamera = createRegionRightCamera();
    this.viewportController = new RegionViewportController(this.rightCamera);
    this.stage = 4;
    this.leftPlayerMeshSource = null;
    this.test = new RegionTestController({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.rightCamera,
      collisionGroup: this.collisionGroup,
      runtime: this.runtime,
      setStatus: (message, error) => this.setStatus?.(message, error),
    });
    this.renderController = new RegionRenderController({
      window,
      renderer: this.renderer,
      host,
      scene: this.scene,
      leftCamera: this.leftCamera,
      rightCamera: this.rightCamera,
      viewportController: this.viewportController,
      regionScene: this.regionScene,
      onBeforeFrame: (dt) => {
        this.test.update(dt);
        const playerMesh = this.test.playerMesh;
        if (playerMesh !== this.leftPlayerMeshSource) {
          this.leftPlayerMeshSource = playerMesh;
          this.regionScene.setPlayerMesh(playerMesh);
        }
      },
      onBeforeRightRender: () => this.updateRegionFillVisibility(),
      getFrameGamePosition: () => [
        this.runtime.physicsState.position.x,
        this.runtime.physicsState.position.y - PLAYER_CAPSULE_FOOT_OFFSET,
        this.runtime.physicsState.position.z,
      ],
      onFrameGamePosition,
      getFollowTarget: () => this.test.mapFollowTarget,
      getStage4Mode: () => this.stage4Mode,
      getStage4FilterRegion: () =>
        this.stage4Mode === "regions" && this.clipRegions
          ? this.stage4FilterRegion
          : null,
      getClipRegions: () => this.clipRegions,
      getOutdoorEnabled: () => this.outdoorRegionEnabled,
    });

    this.raycaster = new THREE.Raycaster();
    this.objParser = createObjParser();
    this.assetLoader = new RegionAssetLoader(this.objParser);
    this.planSystem = new RegionShotPlanSystem({
      getCollisionTargets: () => this.collisionGroup.children,
    });
    this.router = null;
    this.disposed = false;
    this.handleContextMenu = (event) => event.preventDefault();
  }

  start() {
    this.renderer.domElement.addEventListener(
      "contextmenu",
      this.handleContextMenu,
    );
    this.renderController.start();
  }

  createInputRouter(options) {
    this.router?.dispose();
    this.router = this.viewportController.createInputRouter({
      element: this.renderer.domElement,
      document: this.document,
      leftCamera: this.leftCamera,
      raycaster: this.raycaster,
      overlay: this.overlay,
      navGroup: this.navGroup,
      getStage: () => this.stage,
      testHandlers: this.test.handlers(),
      ...options,
    });
    return this.router;
  }

  focusRegion(region, options) {
    this.viewportController.focusRegion(region, this.leftCamera, {
      aspect: this.leftViewportAspect(),
      ...options,
    });
  }

  focusGamePoint(point) {
    this.viewportController.focusPoint(point, this.leftCamera);
  }

  fitFilteredNavmesh() {
    const bounds = new THREE.Box3().setFromObject(this.navGroup);
    if (bounds.isEmpty()) {
      return false;
    }
    this.viewportController.focusBounds(bounds, this.leftCamera, {
      aspect: this.leftViewportAspect(),
    });
    return true;
  }

  focusNavmeshSelection(meshes, { focusRight = false } = {}) {
    const bounds = new THREE.Box3();
    let hasBounds = false;
    for (const mesh of meshes || []) {
      if (!mesh?.isMesh) {
        continue;
      }
      mesh.updateWorldMatrix(true, false);
      const meshBounds = new THREE.Box3().setFromObject(mesh);
      if (meshBounds.isEmpty()) {
        continue;
      }
      bounds.union(meshBounds);
      hasBounds = true;
    }
    if (!hasBounds) {
      return false;
    }

    this.viewportController.focusBounds(bounds, this.leftCamera, {
      aspect: this.leftViewportAspect(),
      focusRight,
    });
    return true;
  }

  setStage(stage) {
    const nextStage = Number(stage) || 4;
    if (nextStage === this.stage) {
      return;
    }
    this.stage = nextStage;
    this.overlay.setCameraPlanVisible(nextStage === 5);
    this.renderController.setStage(nextStage);
    this.updateTestLifecycle();
    this.updateRegionFillVisibility();
  }

  setCameraPlan(plan) {
    this.overlay.renderCameraPlan(plan?.plan?.points || []);
    this.overlay.setCameraPlanVisible(this.stage === 5);
  }

  setStage4Mode(mode) {
    this.stage4Mode = ["navmesh", "regions", "test"].includes(mode)
      ? mode
      : "regions";
    this.updateTestLifecycle();
    this.updateRegionFillVisibility();
  }

  updateTestLifecycle() {
    if (this.stage === 4 && this.stage4Mode === "test") {
      this.test.enter();
    } else {
      this.test.exit();
    }
  }

  toggleTestCameraMode() {
    this.test.toggleMode();
  }

  testSnapshot() {
    return this.test.snapshot;
  }

  resetForMapChange() {
    this.test.resetForMapChange();
    this.leftPlayerMeshSource = null;
    this.regionScene.setPlayerMesh(null);
  }

  setCollisionVisible(visible) {
    this.collisionVisible = Boolean(visible);
    this.applyCollisionDisplayState();
  }

  setCollisionOpacity(opacity) {
    this.collisionOpacity = clampOpacity(opacity);
    this.applyCollisionDisplayState();
  }

  setNavmeshOpacity(opacity) {
    this.navmeshOpacity = Math.max(0, Math.min(1, Number(opacity) || 0));
    this.applyNavmeshDisplayState();
  }

  setClipRegions(enabled) {
    this.clipRegions = Boolean(enabled);
    this.updateRegionFillVisibility();
  }

  setRecordMissingPoints(enabled) {
    this.recordMissingPoints = Boolean(enabled);
  }

  setStage4FilterRegion(region) {
    this.stage4FilterRegion = region || null;
  }

  setOutdoorRegionEnabled(enabled) {
    this.outdoorRegionEnabled = Boolean(enabled);
  }

  updateRegionFillVisibility() {
    const visible =
      this.stage === 5 ||
      (this.stage === 4 &&
        this.stage4Mode !== "test" &&
        !(this.stage4Mode === "regions" && this.clipRegions));
    setRegionFillVisibility(this.overlay.regionGroup, visible);
  }

  applyCollisionDisplayState() {
    for (const group of [this.collisionGroup, this.leftCollisionGroup]) {
      group.visible = this.collisionVisible;
      applyGroupOpacity(group, this.collisionOpacity);
    }
  }

  applyNavmeshDisplayState() {
    for (const group of [this.navGroup, this.leftNavGroup]) {
      applyGroupOpacity(group, this.navmeshOpacity);
    }
  }

  applyDisplayState() {
    this.applyCollisionDisplayState();
    this.applyNavmeshDisplayState();
  }

  leftViewportAspect() {
    return this.host.clientWidth / 2 / Math.max(1, this.host.clientHeight);
  }

  rebuild(navGroup = this.navGroup, collisionGroup = this.collisionGroup) {
    this.applyDisplayState();
    this.planSystem.rebuildCollisionBvh(collisionGroup);
    this.test.rebuildPhysics();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.router?.dispose();
    this.router = null;
    this.renderer.domElement.removeEventListener(
      "contextmenu",
      this.handleContextMenu,
    );
    this.objParser.dispose();
    disposeRegionAssetTargets([{
      navmesh: this.navGroup,
      collision: this.collisionGroup,
    }, {
      navmesh: this.leftNavGroup,
      collision: this.leftCollisionGroup,
    }]);
    this.planSystem.dispose();
    this.renderController.dispose();
    this.regionScene.dispose();
    this.overlay.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function clampOpacity(opacity) {
  return Math.max(0, Math.min(1, Number(opacity) || 0));
}

function applyGroupOpacity(group, opacity) {
  group.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        if (!material) continue;
        material.transparent = opacity < 1;
        material.opacity = opacity;
        material.depthWrite = opacity >= 1;
        material.needsUpdate = true;
      }
    });
}

function setRegionFillVisibility(regionGroup, visible) {
  regionGroup.traverse((object) => {
    if (object.userData?.kind === "region-fill") {
      object.visible = visible;
    }
  });
}

function createRegionRenderer({ window, host }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);
  return renderer;
}
