import * as THREE from "three";
import { RegionClippedMapRenderer } from "./region-clipped-map-renderer.js";
import { RegionStage4FilterRenderer } from "./region-stage4-filter-renderer.js";

export class RegionSceneController {
  constructor({ overlayScene, mapScene, navGroup, collisionGroup }) {
    this.stage4FilterRenderer = new RegionStage4FilterRenderer({
      overlayScene,
      mapScene,
      navGroup,
      collisionGroup,
    });
    this.leftMapRenderer = new RegionClippedMapRenderer({ scene: mapScene });
  }

  setPlayerMesh(mesh) {
    this.leftMapRenderer.setPlayerMesh(mesh);
  }

  renderBase(renderer, camera, viewport) {
    this.stage4FilterRenderer.renderBase(renderer, camera, viewport);
  }

  renderLeftMap(
    renderer,
    camera,
    viewport,
    activeRegions,
    { includeOutdoor = true } = {},
  ) {
    if (includeOutdoor) {
      this.leftMapRenderer.renderBase(renderer, camera, viewport);
    }
    this.leftMapRenderer.render(renderer, camera, viewport, activeRegions, {
      clear: !includeOutdoor,
    });
  }

  renderStage4Filtered(renderer, camera, viewport, region, options) {
    this.stage4FilterRenderer.render(
      renderer,
      camera,
      viewport,
      region,
      options,
    );
  }

  renderStage4WithoutOutdoor(renderer, camera, viewport) {
    this.stage4FilterRenderer.renderWithoutOutdoor(renderer, camera, viewport);
  }

  dispose() {
    this.stage4FilterRenderer.dispose();
    this.leftMapRenderer.dispose();
  }
}

export function createRegionScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1115);
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(120, 220, 100);
  scene.add(directionalLight);
  return scene;
}

export function createRegionLeftCamera() {
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 1000);
  camera.position.set(0, 100, 0);
  camera.lookAt(0, 0, 0);
  return camera;
}

export function createRegionRightCamera() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(25, 25, 25);
  camera.lookAt(0, 0, 0);
  camera.userData.target = new THREE.Vector3();
  return camera;
}
