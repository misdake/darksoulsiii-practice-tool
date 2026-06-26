import { fitCameraToVisibleObjects } from "./filter-camera-fit.js";
import { createFilterSceneParts } from "./filter-scene-setup.js";

export class FilterSceneController {
  static create({ app, window }) {
    return new FilterSceneController(createFilterSceneParts({ app, window }));
  }

  constructor({ renderer, scene, camera, controls, root, csm, clock }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    this.root = root;
    this.csm = csm;
    this.clock = clock;
    this.frame = null;
  }

  start(update) {
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      update(this.clock.getDelta());
      this.csm.update();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.csm.updateFrustums();
  }

  fitCameraToVisibleObjects({ root, groups, controls }) {
    return fitCameraToVisibleObjects({
      camera: this.camera,
      root,
      groups,
      controls,
    });
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.csm.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
