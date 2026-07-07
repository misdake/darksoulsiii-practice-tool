import { saveStageData } from "../../../shared/map-api.js";

export class RegionPlanActions {
  constructor({ state, planController, getMapId, setStatus, applyEditorFields, getPlanConfig, resetPlanConfig }) {
    Object.assign(this, { state, planController, getMapId, setStatus, applyEditorFields, getPlanConfig, resetPlanConfig });
  }

  handlers() {
    return {
      onCalculatePlan: () => this.calculatePlan(),
      onCancelPlan: () => this.planController.cancel(),
      onResetPlanConfig: () => this.resetPlanConfig(),
      onSavePlans: () => this.savePlans(),
    };
  }

  async calculatePlan() {
    if (!this.applyEditorFields()) return;
    await this.planController.calculate(this.getPlanConfig());
  }

  async savePlans() {
    const validPlans = this.state.plans.filter((plan) => isPlanValid(plan, this.state.regionGroups));
    try {
      await saveStageData(this.getMapId(), "stage5-map-region-shot-plans", { plans: validPlans });
      this.state.plans = validPlans;
      this.setStatus("Regional camera plans saved.");
    } catch (error) {
      this.setStatus(`Saving regional camera plans failed: ${error.message}`, true);
    }
  }
}

export function isPlanValid(plan, groups) {
  if (plan?.kind === "fallback") return true;
  if (plan?.kind !== "region_group") return false;
  const group = groups.find((item) => item.uuid === plan.region_group_uuid);
  return Boolean(group && group.last_updated === plan.group_last_updated);
}
