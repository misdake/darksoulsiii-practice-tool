export class FilterMapCameraController {
  constructor({
    root,
    controls,
    sceneController,
    visualController,
    navSystem,
    getCollisionGroup,
    getNavmeshGroup,
  }) {
    this.root = root;
    this.controls = controls;
    this.sceneController = sceneController;
    this.visualController = visualController;
    this.navSystem = navSystem;
    this.getCollisionGroup = getCollisionGroup;
    this.getNavmeshGroup = getNavmeshGroup;
    this.pendingAutoFitFrame = 0;
  }

  fitToMap() {
    this.visualController.applyCollisionVisibility();
    this.navSystem.applyVisibility(true);
    this.visualController.applyNavVisuals();
    this.sceneController.fitCameraToVisibleObjects({
      root: this.root,
      groups: [this.getCollisionGroup(), this.getNavmeshGroup()],
      controls: this.controls,
    });
  }

  scheduleFitToMap() {
    if (this.pendingAutoFitFrame) {
      cancelAnimationFrame(this.pendingAutoFitFrame);
    }
    this.pendingAutoFitFrame = requestAnimationFrame(() => {
      this.pendingAutoFitFrame = 0;
      this.fitToMap();
    });
  }

  dispose() {
    if (this.pendingAutoFitFrame) {
      cancelAnimationFrame(this.pendingAutoFitFrame);
      this.pendingAutoFitFrame = 0;
    }
  }
}
