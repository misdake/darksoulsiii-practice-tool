import { RegionActionsController } from "../actions/region-actions-controller.js";
import { RegionMapLoadController } from "../map/region-map-load-controller.js";
import { RegionMissingPointsController } from "../state/region-missing-points-controller.js";
import { RegionPageSyncController } from "../state/region-page-sync-controller.js";
import { RegionPlanController } from "../planning/region-plan-controller.js";
import { RegionRuntimeController } from "../runtime/region-runtime-controller.js";
import { shouldRecordTestMissing } from "../runtime/region-test-state.js";
import { RegionState } from "../state/region-state.js";
import { RegionUiController } from "../ui/region-ui-controller.js";

export function createRegionControllerGraph({ document, window, navigateBack }) {
  const ui = new RegionUiController(document);
  const state = new RegionState();
  const graph = {
    ui,
    state,
    testUiState: {
      criticalSignature: "",
      positionSignature: "",
      lastPositionUpdate: 0,
    },
  };
  const runtime = new RegionRuntimeController({
    window,
    document,
    host: ui.getCanvasHost(),
    setStatus: ui.status,
    onFrameGamePosition: (position) => updateFrameRegions(graph, position),
  });
  graph.runtime = runtime;

  graph.syncController = new RegionPageSyncController({
    state,
    ui,
    runtime,
  });
  graph.mapLoadController = createMapLoadController(graph);
  graph.missingPoints = createMissingPointsController(graph);
  graph.planController = createPlanController(graph);
  graph.syncController.onRegionSelectionChange = () =>
    graph.planController.cancel("Camera plan cancelled after region selection changed.", false);
  graph.actions = createActionsController(graph, navigateBack);
  return graph;
}

function updateFrameRegions(graph, position) {
  const { missingPoints, runtime, syncController } = graph;
  const snapshot = runtime.testSnapshot();
  if (runtime.stage === 4 && runtime.stage4Mode === "test") {
    const activeRegions = snapshot.playerReady
      ? syncController.updateActiveRegions(position)
      : [];
    if (
      shouldRecordTestMissing({
        stage: runtime.stage,
        stage4Mode: runtime.stage4Mode,
        enabled: runtime.recordMissingPoints,
        mode: snapshot.mode,
        playerReady: snapshot.playerReady,
        paused: snapshot.paused,
        activeRegions,
      })
    ) {
      missingPoints.record(position);
    }
    presentTestStatus(graph, {
      activeRegions,
      missingCount: missingPoints.size,
      mode: snapshot.mode,
      paused: snapshot.paused,
      playerReady: snapshot.playerReady,
      playerPosition: [
        snapshot.position.x,
        snapshot.position.y,
        snapshot.position.z,
      ],
      warning:
        snapshot.playerReady &&
        snapshot.mode === "thirdPerson" &&
        !snapshot.paused &&
        activeRegions.length === 0,
    });
    return activeRegions;
  }
  return [];
}

function presentTestStatus(graph, status) {
  const criticalSignature = JSON.stringify({
    active: status.activeRegions.map((region) => region.name),
    missingCount: status.missingCount,
    mode: status.mode,
    paused: status.paused,
    playerReady: status.playerReady,
    warning: status.warning,
  });
  const positionSignature = status.playerPosition
    .map((value) => Number(value).toFixed(2))
    .join(",");
  const now = Date.now();
  const criticalChanged =
    criticalSignature !== graph.testUiState.criticalSignature;
  const positionDue =
    positionSignature !== graph.testUiState.positionSignature &&
    now - graph.testUiState.lastPositionUpdate >= 100;
  if (!criticalChanged && !positionDue) return;

  graph.testUiState.criticalSignature = criticalSignature;
  graph.testUiState.positionSignature = positionSignature;
  graph.testUiState.lastPositionUpdate = now;
  graph.ui.setTestStatus(status);
}

function createMapLoadController({ runtime, state, ui }) {
  return new RegionMapLoadController({
    assetLoader: runtime.assetLoader,
    navGroup: runtime.navGroup,
    collisionGroup: runtime.collisionGroup,
    leftNavGroup: runtime.leftNavGroup,
    leftCollisionGroup: runtime.leftCollisionGroup,
    sceneController: runtime,
    state,
    setProgress: (text, ratio) => ui.setLoadProgress(text, ratio),
  });
}

function createMissingPointsController({ runtime }) {
  return new RegionMissingPointsController({
    renderPoints: (points) => runtime.overlay.renderUncovered(points),
  });
}

function createPlanController({ runtime, state, syncController, ui }) {
  return new RegionPlanController({
    planSystem: runtime.planSystem,
    state,
    navGroup: runtime.navGroup,
    setStatus: ui.status,
    setPlanning: (planning) => ui.setStage5Planning(planning),
    setProgress: (progress) => ui.setStage5Progress(progress),
    sync: () => syncController.sync(),
  });
}

function createActionsController(graph, navigateBack) {
  const {
    missingPoints,
    planController,
    runtime,
    state,
    syncController,
    ui,
  } = graph;

  return new RegionActionsController({
    state,
    missingPoints,
    planController,
    getMapId: () => state.mapId,
    getRegions: () => state.regions,
    getRegionGroups: () => state.regionGroups,
    setSelectionMode: (mode) => {
      runtime.setStage4Mode(mode);
      syncController.setMode(mode);
    },
    getSelectedNavmeshes: () => syncController.getSelectedNavmeshes(),
    confirm: (message) => ui.confirm(message),
    setStatus: ui.status,
    sync: () => syncController.sync(),
    applyEditorFields: () => syncController.applyEditorFields(),
    getPlanConfig: () => ui.readStage5Config(),
    resetPlanConfig: () => ui.resetStage5Config(),
    focusGamePoint: (point) => runtime.focusGamePoint(point),
    toggleTestCameraMode: () => runtime.toggleTestCameraMode(),
    navigateBack,
  });
}
