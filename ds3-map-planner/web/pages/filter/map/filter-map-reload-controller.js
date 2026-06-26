import { attachLoadedFilterMapData } from "./filter-map-stage-data.js";
import { loadedMapStatus } from "./filter-map-session-status.js";

export class FilterMapReloadController {
  constructor({
    root,
    filterUi,
    mapLoadController,
    stageController,
    visualController,
    collisionSystem,
    navSystem,
    navSegmentUsageStates,
    cameraController,
    detachCurrentGroups,
    rebuildObjectMenus,
    onLoadedMap,
    setLoadProgress,
    setStatus,
  }) {
    this.root = root;
    this.filterUi = filterUi;
    this.mapLoadController = mapLoadController;
    this.stageController = stageController;
    this.visualController = visualController;
    this.collisionSystem = collisionSystem;
    this.navSystem = navSystem;
    this.navSegmentUsageStates = navSegmentUsageStates;
    this.cameraController = cameraController;
    this.detachCurrentGroups = detachCurrentGroups;
    this.rebuildObjectMenus = rebuildObjectMenus;
    this.onLoadedMap = onLoadedMap;
    this.setLoadProgress = setLoadProgress;
    this.setStatus = setStatus;
    this.isReloading = false;
    this.queuedReload = false;
  }

  async loadMapList() {
    this.filterUi.renderMapOptions(await this.mapLoadController.loadMapList());
  }

  async reload() {
    if (this.isReloading) {
      this.queuedReload = true;
      return;
    }

    this.isReloading = true;
    const mapId = this.filterUi.selectedMapId;
    if (!mapId) {
      this.isReloading = false;
      return;
    }

    this.filterUi.setMapSelectDisabled(true);
    this.setLoadProgress(`loading ${mapId}`, 0);
    this.setStatus(`loading ${mapId} ...`);

    try {
      this.navSegmentUsageStates.clear();
      this.detachCurrentGroups();
      await this.loadAndAttachMap(mapId);
    } catch (e) {
      this.setLoadProgress(`load failed ${mapId}`, 0, true);
      this.setStatus(`load failed: ${e.message || e}`, true);
    } finally {
      this.filterUi.setMapSelectDisabled(false);
      this.isReloading = false;
      if (this.queuedReload) {
        this.queuedReload = false;
        void this.reload();
      }
    }
  }

  async loadAndAttachMap(mapId) {
    const loaded = await this.mapLoadController.load(mapId);
    const profileStage = this.stageController.normalizeStage(
      this.stageController.currentStage,
    );

    this.onLoadedMap({
      mapId,
      defaultHitFilterIds: loaded.defaultHitFilterIds,
      collisionGroup: loaded.collisionGroup,
      navmeshGroup: loaded.navmeshGroup,
    });

    attachLoadedFilterMapData({
      root: this.root,
      loaded,
      collisionSystem: this.collisionSystem,
      navSystem: this.navSystem,
      visualController: this.visualController,
      navSegmentUsageStates: this.navSegmentUsageStates,
    });

    this.rebuildObjectMenus();
    this.stageController.applyStage(profileStage);
    this.stageController.notifySceneReloaded();
    this.cameraController.scheduleFitToMap();
    this.setLoadProgress(`loaded ${mapId}`, 1, false);
    this.setStatus(
      loadedMapStatus({
        mapId,
        collisionGroup: loaded.collisionGroup,
        navmeshGroup: loaded.navmeshGroup,
        failedCount: loaded.failedCount,
      }),
    );
  }
}
