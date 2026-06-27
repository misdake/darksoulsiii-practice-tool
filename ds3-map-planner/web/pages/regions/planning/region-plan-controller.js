import { collectNavmeshTriangles } from "../assets/region-navmesh-utils.js";

export function replaceRegionPlan(currentPlans, plan) {
  return [
    ...currentPlans.filter((item) => item.region_name !== plan.region_name),
    plan,
  ];
}

export class RegionPlanController {
  constructor({
    planSystem,
    state,
    navGroup,
    setStatus,
    setPlanning,
    setProgress,
    sync,
  }) {
    this.planSystem = planSystem;
    this.state = state;
    this.navGroup = navGroup;
    this.setStatus = setStatus || (() => {});
    this.setPlanning = setPlanning || (() => {});
    this.setProgress = setProgress || (() => {});
    this.sync = sync;
    this.requestId = 0;
    this.abortController = null;
  }

  async calculate(region, currentPlans, config) {
    if (!region) {
      this.setStatus("Select a region first.", true);
      return currentPlans;
    }

    this.cancel("Superseded by a new calculation.", false);
    const requestId = ++this.requestId;
    const mapId = this.state.mapId;
    const regionName = region.name;
    const abortController = new AbortController();
    this.abortController = abortController;
    this.setPlanning(true);
    this.setProgress({ phase: "target_geometry", processed: 0, total: 1, ratio: 0 });
    this.setStatus(`Calculating camera plan for ${region.name}...`);

    try {
      const plan = await this.planSystem.calculate(
        region,
        collectNavmeshTriangles(this.navGroup),
        config,
        {
          signal: abortController.signal,
          onProgress: (progress) => this.setProgress(progress),
        },
      );
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
        `Calculated ${plan.coverage.final_count} cameras for ${region.name}; ` +
          `${(plan.coverage.coverage_ratio * 100).toFixed(1)}% covered.`,
      );
      return this.state.plans;
    } catch (error) {
      if (error?.name === "AbortError") {
        if (requestId === this.requestId) this.setStatus("Camera plan cancelled.");
      } else {
        this.setStatus(`Regional camera plan failed: ${error.message}`, true);
      }
      return currentPlans;
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
        this.setPlanning(false);
      }
    }
  }

  cancel(reason = "Camera plan cancelled.", showStatus = true) {
    if (!this.abortController) return false;
    this.requestId += 1;
    this.abortController.abort(reason);
    this.abortController = null;
    this.planSystem.cancel?.(reason);
    this.setPlanning(false);
    if (showStatus) this.setStatus(reason);
    return true;
  }
}
