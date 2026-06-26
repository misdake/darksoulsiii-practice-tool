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
      onStageChange: (stage) => runtime.setStage(stage),
      onStage4SelectionModeChange: (mode) =>
        syncController.setSelectionMode(mode),
      onStage4CollisionVisibleChange: (visible) =>
        runtime.setCollisionVisible(visible),
      onStage4CollisionOpacityInput: (opacity) =>
        runtime.setCollisionOpacity(opacity),
      onStage4NavmeshOpacityInput: (opacity) =>
        runtime.setNavmeshOpacity(opacity),
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
      await this.loadMap();
    } catch (error) {
      ui.status(error.message, true);
    }
  }

  async loadMap(mapId = this.graph.ui.selectedMapId) {
    const { mapLoadController, runtime, syncController, ui } = this.graph;
    const token = ++this.loadToken;
    ui.beginMapLoading(mapId);
    syncController.clearSelectedNavmesh();
    const isCurrent = () => token === this.loadToken && !this.disposed;
    try {
      const loaded = await mapLoadController.load(mapId, { isCurrent });
      if (!loaded || !isCurrent()) {
        return;
      }
      syncController.sync();
      ui.status(
        runtime.navGroup.children.length
          ? `Loaded ${loaded.regions.length} regions, ${loaded.assets.navmeshCount} Stage 3 splits and ${loaded.assets.collisionCount} collision meshes.`
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
