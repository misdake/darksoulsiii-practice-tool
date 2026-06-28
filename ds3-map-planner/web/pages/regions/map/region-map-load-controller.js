import { fetchJson, loadOptionalStages } from "../../../shared/map-api.js";

export class RegionMapLoadController {
  constructor({
    assetLoader,
    navGroup,
    collisionGroup,
    sceneController,
    state,
    setProgress,
  }) {
    this.assetLoader = assetLoader;
    this.navGroup = navGroup;
    this.collisionGroup = collisionGroup;
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

    this.state.load({
      mapId,
      regions: savedRegions?.regions || [],
      regionGroups: savedRegions?.region_groups || [],
      plans: savedPlans?.plans || [],
    });

    this.setProgress?.(`loading ${mapId} assets`, 0.15);
    const assets = await this.assetLoader.load(
      mapId,
      {
        navmesh: this.navGroup,
        collision: this.collisionGroup,
      },
      {
        onProgress: (ratio) =>
          this.setProgress?.(`loading ${mapId} assets`, 0.15 + ratio * 0.75),
      },
    );
    if (!isCurrent()) {
      return null;
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
