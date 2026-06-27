const PANEL_COLLAPSED_KEY = "ds3-map-planner.panel-collapsed";

export class FilterPageActionsController {
  constructor({
    ui,
    window,
    stageController,
    mapSession,
    loadMap,
  }) {
    this.ui = ui;
    this.window = window;
    this.stageController = stageController;
    this.mapSession = mapSession;
    this.loadMap = loadMap;
  }

  start() {
    this.restorePanelState();
    this.ui.bindActions({
      onPanelToggle: () => this.togglePanelCollapsed(),
      onStageChange: (stage) => this.stageController.applyStage(stage),
      onMapChange: () => {
        void this.loadMap();
      },
      onFitCamera: () => this.mapSession.fitCameraToMap(),
      onResetVisible: () => this.mapSession.resetVisibleStatesInMemory(),
      onResetNavSegments: () =>
        this.mapSession.resetNavSegmentStatesInMemory(),
      onStage3CollisionHiddenChange: () =>
        this.updateStage3CollisionHidden(),
      onStage3CollisionOpacityInput: () =>
        this.updateStage3CollisionOpacity(),
      onSave: () => this.mapSession.saveCurrentStage(),
      onToggleCameraMode: () => this.toggleCameraMode(),
    });
  }

  dispose() {
    // Event listeners are owned and released by FilterUiController.
  }

  restorePanelState() {
    this.setPanelCollapsed(
      this.window.localStorage.getItem(PANEL_COLLAPSED_KEY) === "1",
    );
  }

  togglePanelCollapsed() {
    this.setPanelCollapsed(
      !this.ui.panel?.classList.contains("panel-collapsed"),
    );
  }

  setPanelCollapsed(collapsed) {
    const next = Boolean(collapsed);
    this.ui.setPanelCollapsed(next);
    this.window.localStorage.setItem(PANEL_COLLAPSED_KEY, next ? "1" : "0");
  }

  updateStage3CollisionHidden() {
    this.currentStageConfig().handleCollisionHiddenChange?.(
      this.stageController.buildContext(),
      this.ui.stage3HideCollision.checked,
    );
  }

  updateStage3CollisionOpacity() {
    this.currentStageConfig().handleCollisionOpacityChange?.(
      this.stageController.buildContext(),
      Number(this.ui.stage3CollisionOpacity.value),
    );
  }

  toggleCameraMode() {
    this.currentStageConfig().handleToggleCameraMode?.(
      this.stageController.buildContext(),
    );
  }

  currentStageConfig() {
    return this.stageController.getStageConfig();
  }
}
