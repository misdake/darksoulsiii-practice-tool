import { FilterMapCameraController } from "./filter-map-camera-controller.js";
import { FilterMapReloadController } from "./filter-map-reload-controller.js";
import {
  resetNavSegmentStatesInMemory,
  resetVisibleStatesInMemory,
} from "../filter-session-resets.js";
import { saveCurrentFilterStage } from "../stage-runtime/filter-stage-save.js";
import {
  detachFilterMapGroups,
  rebuildFilterObjectMenus,
} from "./filter-map-groups.js";

export class FilterMapSessionController {
  constructor({
    root,
    controls,
    filterUi,
    mapLoadController,
    sceneController,
    stageController,
    visualController,
    objectListController,
    collisionSystem,
    navSystem,
    navSegmentUsageStates,
    clearSelection,
    setLoadProgress,
    setStatus,
  }) {
    this.root = root;
    this.stageController = stageController;
    this.visualController = visualController;
    this.objectListController = objectListController;
    this.navSegmentUsageStates = navSegmentUsageStates;
    this.clearSelection = clearSelection;
    this.setStatus = setStatus;
    this.cameraController = new FilterMapCameraController({
      root,
      controls,
      sceneController,
      visualController,
      navSystem,
      getCollisionGroup: () => this.collisionGroup,
      getNavmeshGroup: () => this.navmeshGroup,
    });

    this.currentMapId = "";
    this.collisionGroup = null;
    this.navmeshGroup = null;
    this.currentDefaultHitFilterIds = [8];
    this.reloadController = new FilterMapReloadController({
      root,
      filterUi,
      mapLoadController,
      stageController,
      visualController,
      collisionSystem,
      navSystem,
      navSegmentUsageStates,
      cameraController: this.cameraController,
      detachCurrentGroups: () => this.detachCurrentGroups(),
      rebuildObjectMenus: () => this.rebuildObjectMenus(),
      onLoadedMap: (loaded) => this.setCurrentMap(loaded),
      setLoadProgress,
      setStatus,
    });
  }

  async loadMapList() {
    await this.reloadController.loadMapList();
  }

  async reload() {
    await this.reloadController.reload();
  }

  resetVisibleStatesInMemory() {
    resetVisibleStatesInMemory({
      visualController: this.visualController,
      currentDefaultHitFilterIds: this.currentDefaultHitFilterIds,
      clearSelection: this.clearSelection,
      rebuildObjectMenus: () => this.rebuildObjectMenus(),
      setStatus: this.setStatus,
    });
  }

  resetNavSegmentStatesInMemory() {
    resetNavSegmentStatesInMemory({
      navSegmentUsageStates: this.navSegmentUsageStates,
      clearSelection: this.clearSelection,
      visualController: this.visualController,
      setStatus: this.setStatus,
    });
  }

  fitCameraToMap() {
    this.cameraController.fitToMap();
  }

  async saveCurrentStage() {
    await saveCurrentFilterStage({
      currentMapId: this.currentMapId,
      stageController: this.stageController,
      setStatus: this.setStatus,
    });
  }

  dispose() {
    this.cameraController.dispose();
  }

  setCurrentMap({ mapId, defaultHitFilterIds, collisionGroup, navmeshGroup }) {
    this.currentMapId = mapId;
    this.currentDefaultHitFilterIds = defaultHitFilterIds;
    this.collisionGroup = collisionGroup;
    this.navmeshGroup = navmeshGroup;
  }

  detachCurrentGroups() {
    detachFilterMapGroups(this.root, this.collisionGroup, this.navmeshGroup);
  }

  rebuildObjectMenus() {
    rebuildFilterObjectMenus({
      objectListController: this.objectListController,
      collisionGroup: this.collisionGroup,
      navmeshGroup: this.navmeshGroup,
    });
  }
}
