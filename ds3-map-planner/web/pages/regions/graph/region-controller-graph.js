import { RegionActionsController } from "../actions/region-actions-controller.js";
import { RegionMapLoadController } from "../map/region-map-load-controller.js";
import { RegionMissingPointsController } from "../state/region-missing-points-controller.js";
import { RegionPageSyncController } from "../state/region-page-sync-controller.js";
import { RegionPlanController } from "../planning/region-plan-controller.js";
import { RegionRuntimeController } from "../runtime/region-runtime-controller.js";
import { shouldRecordStage5Missing } from "../runtime/region-stage5-state.js";
import { RegionState } from "../state/region-state.js";
import { RegionUiController } from "../ui/region-ui-controller.js";

export function createRegionControllerGraph({ document, window, navigateBack }) {
  const ui = new RegionUiController(document);
  const state = new RegionState();
  const graph = { ui, state };
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

function updateFrameRegions({ missingPoints, runtime, syncController, ui }, position) {
  const activeRegions = syncController.updateActiveRegions(position);
  const snapshot = runtime.stage5Snapshot();
  if (runtime.stage === 5) {
    if (
      shouldRecordStage5Missing({
        stage: runtime.stage,
        mode: snapshot.mode,
        playerReady: snapshot.playerReady,
        paused: snapshot.paused,
        activeRegions,
      })
    ) {
      missingPoints.record([
        snapshot.position.x,
        snapshot.position.y,
        snapshot.position.z,
      ]);
    }
    ui.setStage5Status({
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
  }
  return activeRegions;
}

function createMapLoadController({ runtime, state, ui }) {
  return new RegionMapLoadController({
    assetLoader: runtime.assetLoader,
    navGroup: runtime.navGroup,
    collisionGroup: runtime.collisionGroup,
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
    setPlanning: (planning) => ui.setStage6Planning(planning),
    setProgress: (progress) => ui.setStage6Progress(progress),
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
    navGroup: runtime.navGroup,
    missingPoints,
    planController,
    getMapId: () => state.mapId,
    getRegions: () => state.regions,
    setRegions: (value) => syncController.setRegions(value),
    getRegionGroups: () => state.regionGroups,
    setRegionGroups: (value) => state.setRegionGroups(value),
    groupSelectedRegions: () => state.groupSelectedRegions(),
    getSelectedIndex: () => state.selectedIndex,
    getSelectedRegionIndices: () => syncController.getSelectedRegionIndices(),
    setSelectedIndex: (value) => syncController.setSelectedIndex(value),
    removeSelectedRegion: () => state.removeSelected(),
    setEditing: (value) => {
      state.editing = Boolean(value) && state.selectedIndex >= 0;
      syncController.sync();
    },
    setSelectionMode: (mode) => syncController.setSelectionMode(mode),
    getSelectedNavmeshes: () => syncController.getSelectedNavmeshes(),
    getPlans: () => state.plans,
    confirm: (message) => ui.confirm(message),
    setStatus: ui.status,
    sync: () => syncController.sync(),
    applyEditorFields: () => syncController.applyEditorFields(),
    getPlanConfig: () => ui.readStage6Config(),
    resetPlanConfig: () => ui.resetStage6Config(),
    focusGamePoint: (point) => runtime.focusGamePoint(point),
    toggleStage5Mode: () => runtime.toggleStage5Mode(),
    navigateBack,
  });
}
