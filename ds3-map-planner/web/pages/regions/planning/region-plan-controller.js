import { collectNavmeshTriangles } from "../assets/region-navmesh-utils.js";
import { planTargetKey } from "../state/region-state.js";

export function replaceRegionPlan(currentPlans, plan) {
  const key = planTargetKey(plan);
  return [...currentPlans.filter((item) => planTargetKey(item) !== key), plan];
}

export class RegionPlanController {
  constructor({ planSystem, state, navGroup, setStatus, setPlanning, setProgress, sync }) {
    Object.assign(this, { planSystem, state, navGroup, sync });
    this.setStatus = setStatus || (() => {});
    this.setPlanning = setPlanning || (() => {});
    this.setProgress = setProgress || (() => {});
    this.requestId = 0;
    this.abortController = null;
  }

  async calculate(config) {
    const target = this.currentTarget();
    if (!target) {
      this.setStatus("The selected region group no longer exists.", true);
      return this.state.plans;
    }
    this.cancel("Superseded by a new calculation.", false);
    const requestId = ++this.requestId;
    const mapId = this.state.mapId;
    const targetKey = target.key;
    const targetVersion = target.group?.last_updated || null;
    const abortController = new AbortController();
    this.abortController = abortController;
    this.setPlanning(true);
    this.setProgress({ phase: "target_geometry", processed: 0, total: 1, ratio: 0 });
    this.setStatus(`Calculating camera plan for ${target.label}...`);
    try {
      const plan = await this.planSystem.calculate(target, collectNavmeshTriangles(this.navGroup), config, {
        signal: abortController.signal,
        onProgress: (progress) => this.setProgress(progress),
      });
      const current = this.currentTarget();
      if (requestId !== this.requestId || this.state.mapId !== mapId || current?.key !== targetKey ||
          (current?.group?.last_updated || null) !== targetVersion) return this.state.plans;
      this.state.plans = replaceRegionPlan(this.state.plans, plan);
      this.sync();
      this.setStatus(`Calculated ${plan.coverage.final_count} cameras for ${target.label}; ${(plan.coverage.coverage_ratio * 100).toFixed(1)}% covered.`);
      return this.state.plans;
    } catch (error) {
      if (error?.name === "AbortError") {
        if (requestId === this.requestId) this.setStatus("Camera plan cancelled.");
      } else this.setStatus(`Regional camera plan failed: ${error.message}`, true);
      return this.state.plans;
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
        this.setPlanning(false);
      }
    }
  }

  currentTarget() {
    if (this.state.planningTargetKey === "fallback") {
      return { kind: "fallback", key: "fallback", label: "Fallback", prisms: null };
    }
    const uuid = this.state.planningTargetKey.replace("region_group:", "");
    const group = this.state.regionGroups.find((item) => item.uuid === uuid);
    return group ? { kind: "region_group", key: `region_group:${uuid}`, label: group.name, group, prisms: group.prisms } : null;
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
