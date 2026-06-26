import { createFilterControllerGraph } from "./graph/filter-controller-graph.js";

export async function startFilterPage() {
  const page = new FilterPageController({ document, window });
  await page.start();
  return page;
}

export class FilterPageController {
  constructor({ document, window }) {
    this.window = window;
    this.disposed = false;
    this.dispose = this.dispose.bind(this);
    this.graph = createFilterControllerGraph({
      document,
      window,
      loadMap: () => this.loadMap(),
    });
  }

  async start() {
    const {
      actionsController,
      inputController,
      mapSession,
      sceneController,
      stageController,
      helpers,
    } = this.graph;

    actionsController.start();
    inputController.start();
    this.window.addEventListener("beforeunload", this.dispose);
    sceneController.start((dt) => {
      stageController.update(dt);
      sceneController.controls.update();
    });
    helpers.updateStageLabels();
    await mapSession.loadMapList();
    await this.loadMap();
  }

  async loadMap(mapId = null) {
    const { mapSession, ui } = this.graph;
    if (mapId && ui.mapSelect) ui.mapSelect.value = mapId;
    await mapSession.reload();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

    const {
      actionsController,
      assetLoader,
      inputController,
      mapSession,
      sceneController,
      ui,
    } = this.graph;

    this.window.removeEventListener("beforeunload", this.dispose);
    mapSession?.dispose();
    actionsController?.dispose();
    assetLoader?.dispose();
    inputController?.dispose();
    ui.dispose();
    sceneController?.dispose();
  }
}
