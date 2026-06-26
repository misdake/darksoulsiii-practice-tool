import * as THREE from "three";
import { createObjParser } from "../../../shared/map-runtime.js";
import { RegionShotPlanSystem } from "../planning/region-shot-plan-system.js";
import { RegionAssetLoader } from "../assets/region-asset-loader.js";
import { RegionOverlayController } from "../overlay/region-overlay-controller.js";
import { RegionRenderController } from "./region-render-controller.js";
import { RegionStage5Controller } from "./region-stage5-controller.js";
import { RegionStage5MapRenderer } from "./region-stage5-map-renderer.js";
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

    this.overlay = new RegionOverlayController(this.scene);
    this.navGroup = new THREE.Group();
    this.collisionGroup = new THREE.Group();
    this.collisionVisible = true;
    this.collisionOpacity = 0.24;
    this.navmeshOpacity = 1;
    this.scene.add(this.navGroup, this.collisionGroup);

    this.regionScene = new RegionSceneController();
    this.leftCamera = createRegionLeftCamera();
    this.rightCamera = createRegionRightCamera();
    this.viewportController = new RegionViewportController(this.rightCamera);
    this.stage = 4;
    this.stage5 = new RegionStage5Controller({
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
        this.stage5.update(dt);
        this.regionScene.setPlayerMesh(this.stage5.playerMesh);
      },
      onBeforeRightRender: () =>
        setRegionFillVisibility(this.overlay.regionGroup, this.stage !== 5),
      getFrameGamePosition: () => [
        this.runtime.physicsState.position.x,
        this.runtime.physicsState.position.y,
        this.runtime.physicsState.position.z,
      ],
      onFrameGamePosition,
      getFollowTarget: () => this.stage5.controls.target,
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
      stage5Handlers: this.stage5.handlers(),
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

  focusNavmeshSelection(meshes) {
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
      focusRight: false,
    });
    return true;
  }

  setGamePosition([x, y, z]) {
    this.runtime.physicsState.position.set(x, y, z);
  }

  setStage(stage) {
    const nextStage = Number(stage) || 4;
    if (nextStage === this.stage) {
      return;
    }
    this.stage = nextStage;
    this.renderController.setStage(nextStage);
    if (nextStage === 5) {
      this.stage5.enter();
    } else {
      this.stage5.exit();
      setRegionFillVisibility(this.overlay.regionGroup, true);
    }
  }

  toggleStage5Mode() {
    this.stage5.toggleMode();
  }

  stage5Snapshot() {
    return this.stage5.snapshot;
  }

  setCollisionVisible(visible) {
    this.collisionVisible = Boolean(visible);
    this.applyCollisionDisplayState();
  }

  setCollisionOpacity(opacity) {
    this.collisionOpacity = Math.max(0, Math.min(1, Number(opacity) || 0));
    this.applyCollisionDisplayState();
  }

  setNavmeshOpacity(opacity) {
    this.navmeshOpacity = Math.max(0, Math.min(1, Number(opacity) || 0));
    this.applyNavmeshDisplayState();
  }

  applyCollisionDisplayState() {
    this.collisionGroup.visible = this.collisionVisible;
    applyGroupOpacity(this.collisionGroup, this.collisionOpacity);
  }

  applyNavmeshDisplayState() {
    applyGroupOpacity(this.navGroup, this.navmeshOpacity);
  }

  applyDisplayState() {
    this.applyCollisionDisplayState();
    this.applyNavmeshDisplayState();
  }

  leftViewportAspect() {
    return this.host.clientWidth / 2 / Math.max(1, this.host.clientHeight);
  }

  rebuildRegionScene() {
    this.regionScene.rebuild(this.navGroup, this.collisionGroup);
  }

  rebuild(navGroup = this.navGroup, collisionGroup = this.collisionGroup) {
    this.applyDisplayState();
    this.regionScene.rebuild(navGroup, collisionGroup);
    this.planSystem.rebuildCollisionBvh(collisionGroup);
    this.stage5.rebuildPhysics();
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
    this.planSystem.dispose();
    this.renderController.dispose();
    this.regionScene.dispose();
    this.overlay.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
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

class RegionSceneController {
  constructor() {
    this.leftMapRenderer = new RegionStage5MapRenderer();
  }

  rebuild(navmeshGroup, collisionGroup) {
    this.leftMapRenderer.rebuild(navmeshGroup, collisionGroup);
  }

  setPlayerMesh(mesh) {
    this.leftMapRenderer.setPlayerMesh(mesh);
  }

  renderLeftMap(renderer, camera, viewport, activeRegions) {
    this.leftMapRenderer.render(renderer, camera, viewport, activeRegions);
  }

  dispose() {
    this.leftMapRenderer.dispose();
  }
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

function createRegionScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1115);
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(120, 220, 100);
  scene.add(directionalLight);
  return scene;
}

function createRegionLeftCamera() {
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 1000);
  camera.position.set(0, 100, 0);
  camera.lookAt(0, 0, 0);
  return camera;
}

function createRegionRightCamera() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(25, 25, 25);
  camera.lookAt(0, 0, 0);
  camera.userData.target = new THREE.Vector3(0, 0, 0);
  return camera;
}
