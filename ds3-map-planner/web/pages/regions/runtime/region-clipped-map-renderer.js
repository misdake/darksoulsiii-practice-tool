import * as THREE from "three";
import {
  captureMaterialState,
  restoreMaterialState,
} from "../../../shared/material-state.js";
import {
  cloneClippedSourceScene,
  disposeStage5Scene,
  applyRegionBroadPhase,
  syncClippedSourceScene,
} from "./region-stage5-scene.js";
import {
  applyRegionClipping,
  createRegionMask,
} from "./region-stage5-mask.js";

export class RegionClippedMapRenderer {
  constructor({
    includeNavmesh = false,
    preserveMaterials = false,
    syncSourceState = preserveMaterials,
    renderPlayer = true,
    manageCollisionDisplay = false,
  } = {}) {
    this.includeNavmesh = includeNavmesh;
    this.preserveMaterials = preserveMaterials;
    this.syncSourceState = syncSourceState;
    this.renderPlayer = renderPlayer;
    this.manageCollisionDisplay = manageCollisionDisplay;
    this.collisionVisible = true;
    this.collisionOpacity = 1;
    this.navmeshOpacity = 1;
    this.scene = new THREE.Scene();
    this.maskScene = new THREE.Scene();
    this.playerScene = createPlayerScene();
    this.copyScene = new THREE.Scene();
    this.copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.copyMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.playerSourceMesh = null;
    this.playerMesh = null;
    this.target = null;

    this.copyScene.add(
      new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMaterial),
    );
  }

  rebuild(navGroup, collisionGroup) {
    disposeStage5Scene(this.scene);
    this.scene = cloneClippedSourceScene(navGroup, collisionGroup, {
      includeNavmesh: this.includeNavmesh,
      preserveMaterials: this.preserveMaterials,
    });
  }

  setPlayerMesh(mesh) {
    if (!mesh) {
      disposeStage5Scene(this.playerScene);
      this.playerScene = createPlayerScene();
      this.playerSourceMesh = null;
      this.playerMesh = null;
      return;
    }
    if (this.playerSourceMesh === mesh && this.playerMesh) {
      this.syncPlayerMesh();
      return;
    }
    disposeStage5Scene(this.playerScene);
    this.playerScene = createPlayerScene();
    this.playerSourceMesh = mesh;
    this.playerMesh = clonePlayerVisual(mesh);
    this.playerScene.add(this.playerMesh);
    this.syncPlayerMesh();
  }

  setCollisionDisplay(visible, opacity) {
    this.collisionVisible = Boolean(visible);
    this.collisionOpacity = Math.max(0, Math.min(1, Number(opacity) || 0));
    this.applyManagedDisplayState();
  }

  setNavmeshOpacity(opacity) {
    this.navmeshOpacity = Math.max(0, Math.min(1, Number(opacity) || 0));
    this.applyManagedDisplayState();
  }

  render(renderer, camera, viewport, regions, { clear = true } = {}) {
    const previousState = captureRendererState(renderer);
    const pixelViewport = normalizePixelViewport(viewport);

    try {
      if (this.syncSourceState) syncClippedSourceScene(this.scene);
      this.applyManagedDisplayState();
      this.prepareViewport(renderer, pixelViewport, clear);
      if (!regions.length) {
        return;
      }

      this.ensureTarget(renderer, pixelViewport.width, pixelViewport.height);
      renderer.localClippingEnabled = true;
      renderer.autoClear = true;

      for (const region of regions) {
        this.renderRegion(renderer, camera, pixelViewport, region);
      }
    } finally {
      restoreRendererState(renderer, previousState);
    }
  }

  renderBase(renderer, camera, viewport) {
    const previousState = captureRendererState(renderer);
    const pixelViewport = normalizePixelViewport(viewport);
    try {
      if (this.syncSourceState) syncClippedSourceScene(this.scene);
      this.resetSceneVisibility();
      this.applyManagedDisplayState();
      this.prepareViewport(renderer, pixelViewport, true);
      renderer.localClippingEnabled = false;
      renderer.autoClear = false;
      renderer.render(this.scene, camera);
      this.syncPlayerMesh();
      if (this.renderPlayer && this.playerMesh?.visible) {
        renderer.render(this.playerScene, camera);
      }
    } finally {
      restoreRendererState(renderer, previousState);
    }
  }

  dispose() {
    disposeStage5Scene(this.scene);
    disposeStage5Scene(this.maskScene);
    disposeStage5Scene(this.playerScene);
    this.target?.dispose();
    this.copyScene.traverse((object) => object.geometry?.dispose?.());
    this.copyMaterial.dispose();
  }

  ensureTarget(renderer, width, height) {
    if (this.target?.width === width && this.target?.height === height) {
      return;
    }

    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: true,
      samples: 0,
    });
  }

  prepareViewport(renderer, viewport, clear) {
    renderer.setScissorTest(true);
    renderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height);
    renderer.setScissor(viewport.x, viewport.y, viewport.width, viewport.height);
    if (clear) {
      renderer.setClearColor(0x10151d, 1);
      renderer.clear(true, true, true);
    }
  }

  resetSceneVisibility() {
    for (const root of this.scene.children) {
      const sourceGroup = root.userData?.sourceGroup;
      if (sourceGroup) {
        root.visible = this.syncSourceState ? sourceGroup.visible : true;
      }
    }
    this.scene.traverse((object) => {
      if (!object.isMesh) return;
      const source = object.userData?.sourceObject;
      object.visible = this.syncSourceState ? source?.visible !== false : true;
    });
  }

  applyManagedDisplayState() {
    if (!this.manageCollisionDisplay) return;
    const collisionRoot = this.scene.children.find(
      (object) => object.userData?.kind === "collision",
    );
    if (!collisionRoot) return;
    collisionRoot.visible = this.collisionVisible;
    collisionRoot.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        material.opacity = this.collisionOpacity;
        material.transparent = this.collisionOpacity < 1;
        material.depthWrite = this.collisionOpacity >= 1;
        material.needsUpdate = true;
      }
    });
    const navmeshRoot = this.scene.children.find(
      (object) => object.userData?.kind === "navmesh",
    );
    navmeshRoot?.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        material.opacity = this.navmeshOpacity;
        material.transparent = this.navmeshOpacity < 1;
        material.depthWrite = this.navmeshOpacity >= 1;
        material.needsUpdate = true;
      }
    });
  }

  renderRegion(renderer, camera, viewport, region) {
    const materialState = captureMaterialState(this.scene);
    renderer.setRenderTarget(this.target);
    renderer.setViewport(0, 0, viewport.width, viewport.height);
    renderer.setScissor(0, 0, viewport.width, viewport.height);
    renderer.setClearColor(0, 0, 0, 0);
    renderer.clear(true, true, true);

    disposeStage5Scene(this.maskScene, { disposeGeometry: true });
    this.maskScene.add(createRegionMask(region));
    renderer.render(this.maskScene, camera);

    try {
      applyRegionBroadPhase(this.scene, region);
      applyRegionClipping(this.scene, region);
      renderer.autoClear = false;
      renderer.render(this.scene, camera);
      this.syncPlayerMesh();
      if (this.renderPlayer && this.playerMesh?.visible) {
        renderer.render(this.playerScene, camera);
      }
    } finally {
      restoreMaterialState(materialState);
    }

    renderer.setRenderTarget(null);
    renderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height);
    renderer.setScissor(viewport.x, viewport.y, viewport.width, viewport.height);
    this.copyMaterial.map = this.target.texture;
    renderer.render(this.copyScene, this.copyCamera);
    renderer.autoClear = true;
  }

  syncPlayerMesh() {
    if (!this.playerSourceMesh || !this.playerMesh) return;
    this.playerMesh.visible = this.playerSourceMesh.visible;
    this.playerMesh.position.copy(this.playerSourceMesh.position);
    this.playerMesh.quaternion.copy(this.playerSourceMesh.quaternion);
    this.playerMesh.scale.copy(this.playerSourceMesh.scale);
    for (let index = 0; index < this.playerSourceMesh.children.length; index += 1) {
      const sourceChild = this.playerSourceMesh.children[index];
      const cloneChild = this.playerMesh.children[index];
      if (!cloneChild) continue;
      cloneChild.position.copy(sourceChild.position);
      cloneChild.quaternion.copy(sourceChild.quaternion);
      cloneChild.scale.copy(sourceChild.scale);
    }
    this.playerMesh.updateMatrixWorld(true);
  }
}

export class RegionStage5MapRenderer extends RegionClippedMapRenderer {}

function createPlayerScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(120, 220, 100);
  scene.add(directionalLight);
  return scene;
}

function clonePlayerVisual(source) {
  const clone = new THREE.Mesh(
    source.geometry,
    createPlayerMaterial(0x87f5b1),
  );
  clone.userData.kind = source.userData.kind;
  for (const child of source.children) {
    if (!child.isMesh) continue;
    const childClone = new THREE.Mesh(
      child.geometry,
      createPlayerMaterial(
        child.userData.kind === "camera-direction" ? 0xfacc15 : 0x87f5b1,
      ),
    );
    childClone.position.copy(child.position);
    childClone.quaternion.copy(child.quaternion);
    childClone.scale.copy(child.scale);
    childClone.userData.kind = child.userData.kind;
    clone.add(childClone);
  }
  return clone;
}

function createPlayerMaterial(color) {
  return new THREE.MeshLambertMaterial({
    color,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
}

function normalizePixelViewport(viewport) {
  const x = Math.floor(viewport.x);
  const y = Math.floor(viewport.y);
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  return { x, y, width, height };
}

function captureRendererState(renderer) {
  return {
    target: renderer.getRenderTarget(),
    autoClear: renderer.autoClear,
    clipping: renderer.localClippingEnabled,
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
  };
}

function restoreRendererState(renderer, state) {
  renderer.setRenderTarget(state.target);
  renderer.setViewport(state.viewport);
  renderer.setScissor(state.scissor);
  renderer.setScissorTest(state.scissorTest);
  renderer.autoClear = state.autoClear;
  renderer.localClippingEnabled = state.clipping;
  renderer.setClearColor(state.clearColor, state.clearAlpha);
}
