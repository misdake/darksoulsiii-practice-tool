import { fetchJson, loadOptionalStages } from "../../../shared/map-api.js";

export class RegionMapLoadController {
  constructor({
    assetLoader,
    navGroup,
    collisionGroup,
    leftNavGroup,
    leftCollisionGroup,
    sceneController,
    state,
    setProgress,
  }) {
    this.assetLoader = assetLoader;
    this.navGroup = navGroup;
    this.collisionGroup = collisionGroup;
    this.leftNavGroup = leftNavGroup;
    this.leftCollisionGroup = leftCollisionGroup;
    this.sceneController = sceneController;
    this.state = state;
    this.setProgress = setProgress;
  }

  async loadMapList() {
    const data = await fetchJson("/api/maps");
    return data.maps || [];
  }

  async load(mapId, { isCurrent = () => true } = {}) {
    this.setProgress?.(`loading ${mapId} stage data`, 0.05);
    const stages = await loadOptionalStages(mapId, [
      "stage4-map-regions",
      "stage5-map-region-shot-plans",
    ]);
    if (!isCurrent()) {
      return null;
    }
    const savedRegions = stages["stage4-map-regions"];
    const savedPlans = stages["stage5-map-region-shot-plans"];

    this.setProgress?.(`loading ${mapId} assets`, 0.15);
    const bundle = await this.assetLoader.load(mapId, {
      targetCount: 2,
      onProgress: (ratio) => {
        if (isCurrent()) {
          this.setProgress?.(`loading ${mapId} assets`, 0.15 + ratio * 0.75);
        }
      },
    });
    if (!isCurrent()) {
      bundle.dispose();
      return null;
    }
    let assets;
    try {
      this.state.load({
        mapId,
        regions: savedRegions?.regions || [],
        regionGroups: savedRegions?.region_groups || [],
        plans: savedPlans?.plans || [],
      });
      assets = bundle.install([
        { navmesh: this.navGroup, collision: this.collisionGroup },
        { navmesh: this.leftNavGroup, collision: this.leftCollisionGroup },
      ]);
    } catch (error) {
      bundle.dispose();
      throw error;
    }
    this.setProgress?.(`building ${mapId} scene`, 0.95);
    this.sceneController.rebuild(this.navGroup, this.collisionGroup);
    this.setProgress?.(`loaded ${mapId}`, 1);

    return {
      assets,
      regions: this.state.regions,
      plans: this.state.plans,
      selectedIndex: this.state.selectedIndex,
    };
  }
}
