import { createRegionControllerGraph } from "./graph/region-controller-graph.js";

export function startRegionPage() {
  const page = new RegionPageController({ document, window });
  void page.start();
  return page;
}

export class RegionPageController {
  constructor({ document, window }) {
    this.window = window;
    this.disposed = false;
    this.loadToken = 0;
    this.graph = createRegionControllerGraph({
      document,
      window,
      navigateBack: () => {
        this.window.location.href = "./index.html";
      },
    });

    this.dispose = this.dispose.bind(this);
  }

  async start() {
    const { actions, mapLoadController, runtime, syncController, ui } =
      this.graph;

    ui.bindActions({
      ...actions.createHandlers(),
      onFitCamera: () => {
        if (!runtime.fitFilteredNavmesh()) {
          ui.status("No filtered navmesh split is loaded.", true);
        }
      },
      onStageChange: (stage) => {
        if (stage !== 5) {
          this.graph.planController.cancel("Camera plan cancelled after leaving Stage 5.", false);
        }
        if (stage === 5) {
          syncController.suspendModeSelection();
          runtime.setStage(stage);
          syncController.ensureStage5Selection();
        } else {
          runtime.setStage(stage);
          syncController.resumeModeSelection();
        }
      },
      onStage4ModeChange: (mode) => {
        runtime.setStage4Mode(mode);
        syncController.setMode(mode);
      },
      onCollisionVisibleChange: (visible) =>
        runtime.setCollisionVisible(visible),
      onCollisionOpacityInput: (opacity) =>
        runtime.setCollisionOpacity(opacity),
      onNavmeshOpacityInput: (opacity) =>
        runtime.setNavmeshOpacity(opacity),
      onClipRegionsChange: (enabled) => runtime.setClipRegions(enabled),
      onRecordMissingPointsChange: (enabled) =>
        runtime.setRecordMissingPoints(enabled),
      onShowOutdoorRegionChange: (enabled) =>
        runtime.setOutdoorRegionEnabled(enabled),
      onSelectStage5Region: (targetKey) =>
        syncController.selectPlanTarget(targetKey),
    });
    runtime.createInputRouter(syncController.createInputCallbacks());
    this.window.addEventListener("beforeunload", this.dispose);
    runtime.start();

    try {
      const maps = await mapLoadController.loadMapList();
      ui.renderMapOptions(maps);
      ui.onMapChange(() => {
        void this.loadMap();
      });
      const params = new URLSearchParams(this.window.location.search);
      const requestedMap = params.get("map");
      const mapId = maps.some((map) => map.map_id === requestedMap)
        ? requestedMap
        : undefined;
      await this.loadMap(mapId);
      const requestedStage = Number(params.get("stage"));
      if (requestedStage === 4 || requestedStage === 5) {
        ui.setActiveStage(requestedStage);
      }
    } catch (error) {
      ui.status(error.message, true);
    }
  }

  async loadMap(mapId = this.graph.ui.selectedMapId) {
    const {
      mapLoadController,
      missingPoints,
      planController,
      runtime,
      syncController,
      ui,
    } = this.graph;
    if (mapId && ui.mapSelect) {
      ui.mapSelect.value = mapId;
    }
    planController.cancel("Camera plan cancelled after map change.", false);
    missingPoints.clear();
    Object.assign(this.graph.testUiState, {
      criticalSignature: "",
      positionSignature: "",
      lastPositionUpdate: 0,
    });
    runtime.resetForMapChange();
    const token = ++this.loadToken;
    ui.beginMapLoading(mapId);
    syncController.resetModeSelections();
    const isCurrent = () => token === this.loadToken && !this.disposed;
    try {
      const loaded = await mapLoadController.load(mapId, { isCurrent });
      if (!loaded || !isCurrent()) {
        return;
      }
      syncController.sync();
      runtime.fitFilteredNavmesh();
      ui.status(
        runtime.navGroup.children.length
          ? `Loaded ${loaded.groupCount} groups / ${loaded.prismCount} prisms, ${loaded.assets.navmeshCount} Stage 3 splits and ${loaded.assets.collisionCount} collision meshes.`
          : "No Stage 3 navmesh split is selected. Return to the filter page, mark and save at least one split.",
        !runtime.navGroup.children.length,
      );
    } catch (error) {
      if (isCurrent()) {
        ui.status(error.message, true);
      }
    } finally {
      if (isCurrent()) {
        ui.finishMapLoading();
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.window.removeEventListener("beforeunload", this.dispose);
    this.graph.ui.dispose();
    this.graph.runtime.dispose();
  }
}
