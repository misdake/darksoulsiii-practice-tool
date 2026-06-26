import { filterTrianglesForRegion } from "../geometry/region-geometry.js";
import { collectNavmeshTriangles } from "../assets/region-navmesh-utils.js";

export function replaceRegionPlan(currentPlans, plan) {
  return [
    ...currentPlans.filter((item) => item.region_name !== plan.region_name),
    plan,
  ];
}

export class RegionPlanController {
  constructor({ planSystem, state, navGroup, setStatus, setDisabled, sync }) {
    this.planSystem = planSystem;
    this.state = state;
    this.navGroup = navGroup;
    this.setStatus = setStatus;
    this.setDisabled = setDisabled;
    this.sync = sync;
    this.requestId = 0;
  }

  async calculate(region, currentPlans) {
    if (!region) {
      this.setStatus("Select a region first.", true);
      return currentPlans;
    }

    const triangles = filterTrianglesForRegion(
      collectNavmeshTriangles(this.navGroup),
      region,
    );
    if (!triangles.length) {
      this.setStatus(
        "This region contains no selected Stage 3 navmesh triangles.",
        true,
      );
      return currentPlans;
    }

    const requestId = ++this.requestId;
    const mapId = this.state.mapId;
    const regionName = region.name;
    this.setDisabled(true);
    this.setStatus(`Calculating ${region.name} candidates in worker...`);
    try {
      const plan = await this.planSystem.calculate(region, triangles);
      if (
        requestId !== this.requestId ||
        this.state.mapId !== mapId ||
        !this.state.regions.some((item) => item.name === regionName)
      ) {
        return currentPlans;
      }
      this.state.plans = replaceRegionPlan(currentPlans, plan);
      this.sync();
      this.setStatus(
        `Calculated ${plan.plan.points.length} cameras for ${region.name}; lowered ${plan.coverage.lowered_count}, rejected ${plan.coverage.rejected_count}.`,
      );
      return this.state.plans;
    } catch (error) {
      this.setStatus(`Regional camera plan failed: ${error.message}`, true);
      return currentPlans;
    } finally {
      this.setDisabled(false);
    }
  }
}
