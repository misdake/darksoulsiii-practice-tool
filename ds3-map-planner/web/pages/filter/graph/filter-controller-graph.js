import { FilterAssetLoader } from "../assets/filter-asset-loader.js";
import { FilterInputController } from "../input/filter-input-controller.js";
import { FilterPickController } from "../input/filter-pick-controller.js";
import { FilterSelectionController } from "../input/filter-selection-controller.js";
import { FilterMapLoadController } from "../map/filter-map-load-controller.js";
import { displayName, extractBlockKey } from "../map/filter-map-keys.js";
import { FilterMapSessionController } from "../map/filter-map-session-controller.js";
import { FilterRuntimeController } from "../runtime/filter-runtime-controller.js";
import { FilterSceneController } from "../scene/filter-scene-controller.js";
import { FilterVisualController } from "../scene/filter-visual-controller.js";
import { FilterNavSegmentUsage } from "../stage-runtime/filter-nav-segment-usage.js";
import { FilterStageController } from "../stage-runtime/filter-stage-controller.js";
import { getHitFilterTypeLabel } from "../ui/filter-hit-filter-labels.js";
import { FilterObjectListController } from "../ui/filter-object-list-controller.js";
import { FilterPageActionsController } from "../ui/filter-page-actions-controller.js";
import { FilterUiController } from "../ui/filter-ui-controller.js";

export function createFilterControllerGraph({ document, window, loadMap }) {
  const graph = createFilterCoreGraph({ document, window });
  installFilterStageGraph(graph);
  installFilterIoGraph(graph, { document, window, loadMap });
  return graph;
}

function createFilterCoreGraph({ document, window }) {
  const ui = new FilterUiController(document);
  const sceneController = FilterSceneController.create({
    app: document.getElementById("app"),
    window,
  });
  const runtimeController = new FilterRuntimeController();
  const navSegmentUsage = new FilterNavSegmentUsage();
  const graph = {
    ui,
    sceneController,
    runtimeController,
    navSegmentUsage,
    mapSession: null,
  };

  graph.helpers = createFilterGraphHelpers(graph);
  return graph;
}

function createFilterGraphHelpers(graph) {
  return {
    getStageConfig: (stage = graph.stageController.currentStage) =>
      graph.stageController.getStageConfig(stage),
    buildStageContext: () => graph.stageController.buildContext(),
    updateStageLabels: () =>
      graph.ui.renderStageLabels(graph.runtimeController.stageManager),
    setLoadProgress: (text, ratio, visible = true) =>
      graph.ui.setProgress(text, ratio, visible),
    applyNavVisuals: () => graph.visualController.applyNavVisuals(),
    applyCollisionVisuals: () =>
      graph.visualController.applyCollisionVisuals(),
    applyCollisionVisibility: () =>
      graph.visualController.applyCollisionVisibility(),
  };
}

function installFilterStageGraph(graph) {
  installSelectionController(graph);
  installVisualController(graph);
  installStageController(graph);
}

function installSelectionController(graph) {
  const { helpers } = graph;

  graph.selectionController = new FilterSelectionController({
    onVisualsChanged: () => {
      helpers.applyCollisionVisuals();
      helpers.applyNavVisuals();
    },
    onTargetVisibilityChanged: () => {
      helpers.applyCollisionVisibility();
      helpers.applyNavVisuals();
    },
    onTargetHidden: () => graph.mapSession?.rebuildObjectMenus(),
  });
}

function installVisualController(graph) {
  const {
    navSegmentUsage,
    runtimeController,
    sceneController,
    selectionController,
  } = graph;
  const { csm } = sceneController;
  const { collisionSystem, navSystem } = runtimeController;

  graph.visualController = new FilterVisualController({
    csm,
    collisionSystem,
    navSystem,
    getCollisionGroup: () => graph.mapSession?.collisionGroup || null,
    getNavmeshGroup: () => graph.mapSession?.navmeshGroup || null,
    getSelectedTarget: () => selectionController.selectedTarget,
    getSegmentState: (path, segmentIndex) =>
      navSegmentUsage.getState(path, segmentIndex),
    getSegmentUsage: (path, segmentIndex) =>
      navSegmentUsage.getUsage(path, segmentIndex),
    extractBlockKey,
  });
}

function installStageController(graph) {
  const {
    helpers,
    navSegmentUsage,
    runtimeController,
    sceneController,
    selectionController,
    ui,
  } = graph;
  const { camera, controls, renderer, root, scene } = sceneController;
  const { runtime, stageManager, systems } = runtimeController;

  graph.stageController = new FilterStageController({
    stageManager,
    defaultStage: runtimeController.defaultStage,
    stageRadioEls: ui.stageRadios,
    stageObjectListsEl: ui.stageObjectLists,
    stage12ControlsEl: ui.stage12Controls,
    stage3ControlsEl: ui.stage3Controls,
    cameraModeBtn: ui.cameraModeButton,
    stage3HideCollisionEl: ui.stage3HideCollision,
    stage3CollisionOpacityEl: ui.stage3CollisionOpacity,
    stage3CollisionOpacityValueEl: ui.stage3CollisionOpacityValue,
    staticContext: {
      camera,
      controls,
      scene,
      root,
      renderer,
      runtime,
    },
    getCollisionGroup: () => graph.mapSession?.collisionGroup || null,
    getNavmeshGroup: () => graph.mapSession?.navmeshGroup || null,
    getSelectedTarget: () => selectionController.selectedTarget,
    navSegmentUsageStates: navSegmentUsage.states,
    systems,
    callbacks: {
      applyNavVisuals: () => helpers.applyNavVisuals(),
      applyCollisionVisibility: () => helpers.applyCollisionVisibility(),
      applyCollisionVisuals: () => helpers.applyCollisionVisuals(),
      clearSelection: () => selectionController.clearSelection(),
      hideSelectedObject: () => selectionController.hideSelectedObject(),
      setStatus: ui.status,
    },
  });
}

function installFilterIoGraph(graph, { document, window, loadMap }) {
  installFilterAssetGraph(graph, window);
  installFilterObjectListGraph(graph, document);
  installFilterInputGraph(graph, { document, window });
  installFilterSessionGraph(graph);
  installFilterPageActionGraph(graph, { window, loadMap });
}

function installFilterAssetGraph(graph, window) {
  const { helpers } = graph;

  graph.assetLoader = new FilterAssetLoader({
    makeMaterial: (kind) => graph.visualController.makeMaterial(kind),
    workerCount: workerCountFor(window.navigator.hardwareConcurrency),
  });

  graph.mapLoadController = new FilterMapLoadController({
    assetLoader: graph.assetLoader,
    setProgress: (text, ratio, visible) =>
      helpers.setLoadProgress(text, ratio, visible),
  });
}

function workerCountFor(hardwareConcurrency = 8) {
  return Math.max(2, Math.min(8, Math.floor((hardwareConcurrency || 8) / 2)));
}

function installFilterObjectListGraph(graph, document) {
  const { helpers, selectionController, ui } = graph;

  graph.objectListController = new FilterObjectListController({
    document,
    collisionListEl: ui.collisionList,
    navmeshListEl: ui.navmeshList,
    hitFilterListEl: ui.hitFilterList,
    displayName,
    getHitFilterTypeLabel,
    getStageConfig: (stage) => helpers.getStageConfig(stage),
    onCollisionVisibilityChanged: () => helpers.applyCollisionVisibility(),
    onNavVisibilityChanged: () => helpers.applyNavVisuals(),
    onCollisionVisualsChanged: () => helpers.applyCollisionVisuals(),
    onSelectTarget: (target) =>
      selectionController.setSelectedTarget(target),
  });
  selectionController.setObjectListController(graph.objectListController);
}

function installFilterInputGraph(graph, { document, window }) {
  const { helpers, sceneController, selectionController } = graph;
  const { camera, renderer, root } = sceneController;

  graph.pickController = new FilterPickController({
    element: renderer.domElement,
    camera,
    root,
    getCollisionGroup: () => graph.mapSession?.collisionGroup || null,
    getNavmeshGroup: () => graph.mapSession?.navmeshGroup || null,
    getStageConfig: (stage) => helpers.getStageConfig(stage),
  });

  graph.inputController = new FilterInputController({
    document,
    window,
    element: renderer.domElement,
    getStageConfig: (stage) => helpers.getStageConfig(stage),
    buildStageContext: () => helpers.buildStageContext(),
    getPick: (event) => graph.pickController.pick(event),
    onSelectTarget: (target) =>
      selectionController.setSelectedTarget(target),
    onResize: () =>
      sceneController.resize(window.innerWidth, window.innerHeight),
  });
}

function installFilterSessionGraph(graph) {
  const {
    helpers,
    mapLoadController,
    navSegmentUsage,
    objectListController,
    runtimeController,
    sceneController,
    selectionController,
    stageController,
    ui,
    visualController,
  } = graph;
  const { controls, root } = sceneController;
  const { collisionSystem, navSystem } = runtimeController;

  graph.mapSession = new FilterMapSessionController({
    root,
    controls,
    filterUi: ui,
    mapLoadController,
    sceneController,
    stageController,
    visualController,
    objectListController,
    collisionSystem,
    navSystem,
    navSegmentUsageStates: navSegmentUsage.states,
    clearSelection: () => selectionController.clearSelection(),
    setLoadProgress: (text, ratio, visible) =>
      helpers.setLoadProgress(text, ratio, visible),
    setStatus: ui.status,
  });
}

function installFilterPageActionGraph(graph, { window, loadMap }) {
  graph.actionsController = new FilterPageActionsController({
    ui: graph.ui,
    window,
    stageController: graph.stageController,
    mapSession: graph.mapSession,
    loadMap,
  });
}
