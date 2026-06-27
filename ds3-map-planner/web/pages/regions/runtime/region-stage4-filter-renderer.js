import * as THREE from "three";
import { RegionClippedMapRenderer } from "./region-clipped-map-renderer.js";

export class RegionStage4FilterRenderer {
  constructor({ scene, navGroup, collisionGroup }) {
    this.scene = scene;
    this.navGroup = navGroup;
    this.collisionGroup = collisionGroup;
    this.clippedRenderer = new RegionClippedMapRenderer({
      includeNavmesh: true,
      preserveMaterials: false,
      syncSourceState: true,
      renderPlayer: false,
    });
  }

  rebuild(navGroup, collisionGroup) {
    this.clippedRenderer.rebuild(navGroup, collisionGroup);
  }

  render(renderer, camera, viewport, region) {
    this.clippedRenderer.render(renderer, camera, viewport, [region]);
    this.renderEditorOverlay(renderer, camera, viewport);
  }

  renderEditorOverlay(renderer, camera, viewport) {
    const state = captureOverlayState(
      renderer,
      this.scene,
      this.navGroup,
      this.collisionGroup,
    );
    try {
      this.navGroup.visible = false;
      this.collisionGroup.visible = false;
      // A color background makes Three.js clear the framebuffer even when
      // autoClear is disabled, which would erase the clipped map below.
      this.scene.background = null;
      renderer.setScissorTest(true);
      renderer.setViewport(
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height,
      );
      renderer.setScissor(
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height,
      );
      renderer.autoClear = false;
      renderer.localClippingEnabled = false;
      renderer.render(this.scene, camera);
    } finally {
      restoreOverlayState(
        renderer,
        this.scene,
        this.navGroup,
        this.collisionGroup,
        state,
      );
    }
  }

  dispose() {
    this.clippedRenderer.dispose();
  }
}

function captureOverlayState(renderer, scene, navGroup, collisionGroup) {
  return {
    background: scene.background,
    navVisible: navGroup.visible,
    collisionVisible: collisionGroup.visible,
    autoClear: renderer.autoClear,
    clipping: renderer.localClippingEnabled,
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
  };
}

function restoreOverlayState(
  renderer,
  scene,
  navGroup,
  collisionGroup,
  state,
) {
  scene.background = state.background;
  navGroup.visible = state.navVisible;
  collisionGroup.visible = state.collisionVisible;
  renderer.autoClear = state.autoClear;
  renderer.localClippingEnabled = state.clipping;
  renderer.setViewport(state.viewport);
  renderer.setScissor(state.scissor);
  renderer.setScissorTest(state.scissorTest);
}
