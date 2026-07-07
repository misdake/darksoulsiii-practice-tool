import { fetchJson, loadOptionalStages } from "../../../shared/map-api.js";
import { validateRegionGroups } from "../geometry/region-geometry.js";
import { isValidUuid } from "../state/region-state.js";

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
        regionGroups: readRegionGroups(savedRegions),
        plans: readStage5Plans(savedPlans),
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
      prismCount: this.state.regions.length,
      groupCount: this.state.regionGroups.length,
      plans: this.state.plans,
      selectedIndex: this.state.selectedIndex,
    };
  }
}

function readRegionGroups(stageData) {
  if (!stageData) return [];
  if (Object.hasOwn(stageData, "regions")) {
    throw new Error("This map still uses the old Stage 4 regions schema. Run the one-time migration.");
  }
  if (!Array.isArray(stageData.region_groups)) {
    throw new Error("Stage 4 data must contain region_groups[].");
  }
  const error = validateRegionGroups(stageData.region_groups);
  if (error) throw new Error(`Invalid Stage 4 data: ${error}`);
  return stageData.region_groups;
}

export function readStage5Plans(stageData) {
  if (!stageData) return [];
  if (!Array.isArray(stageData.plans)) throw new Error("Stage 5 data must contain plans[].");
  const keys = new Set();
  for (const plan of stageData.plans) {
    const key = plan?.kind === "fallback"
      ? "fallback"
      : plan?.kind === "region_group" && isValidUuid(plan.region_group_uuid) &&
          typeof plan.region_group_name === "string" && plan.region_group_name.trim() &&
          isIsoTimestamp(plan.group_last_updated)
        ? `region_group:${plan.region_group_uuid}`
        : null;
    if (!key) throw new Error("Invalid Stage 5 plan target; old per-region plans are not supported.");
    if (keys.has(key)) throw new Error(`Duplicate Stage 5 plan target '${key}'.`);
    keys.add(key);
  }
  return stageData.plans;
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
