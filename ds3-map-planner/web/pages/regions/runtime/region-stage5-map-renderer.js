import * as THREE from "three";
import {
  captureMaterialState,
  restoreMaterialState,
} from "../../../shared/material-state.js";
import {
  cloneStage5SourceScene,
  disposeStage5Scene,
} from "./region-stage5-scene.js";
import {
  applyRegionClipping,
  createRegionMask,
} from "./region-stage5-mask.js";

export class RegionStage5MapRenderer {
  constructor() {
    this.scene = new THREE.Scene();
    this.maskScene = new THREE.Scene();
    this.playerScene = new THREE.Scene();
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
    this.scene = cloneStage5SourceScene(navGroup, collisionGroup);
  }

  setPlayerMesh(mesh) {
    if (!mesh) {
      this.playerSourceMesh = null;
      this.playerMesh = null;
      this.playerScene.clear();
      return;
    }
    if (this.playerSourceMesh === mesh && this.playerMesh) {
      this.syncPlayerMesh();
      return;
    }
    this.playerScene.clear();
    this.playerSourceMesh = mesh;
    this.playerMesh = new THREE.Mesh(
      mesh.geometry,
      new THREE.MeshBasicMaterial({
        color: 0x87f5b1,
        transparent: false,
        opacity: 1,
        depthTest: true,
        depthWrite: true,
      }),
    );
    this.playerScene.add(this.playerMesh);
    this.syncPlayerMesh();
  }

  render(renderer, camera, viewport, regions) {
    const previousState = captureRendererState(renderer);
    const pixelViewport = normalizePixelViewport(viewport);

    try {
      this.prepareViewport(renderer, pixelViewport);
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

  prepareViewport(renderer, viewport) {
    renderer.setScissorTest(true);
    renderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height);
    renderer.setScissor(viewport.x, viewport.y, viewport.width, viewport.height);
    renderer.setClearColor(0x10151d, 1);
    renderer.clear(true, true, true);
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
      applyRegionClipping(this.scene, region);
      renderer.autoClear = false;
      renderer.render(this.scene, camera);
      this.syncPlayerMesh();
      if (this.playerMesh?.visible) {
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
    this.playerMesh.updateMatrixWorld(true);
  }
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
