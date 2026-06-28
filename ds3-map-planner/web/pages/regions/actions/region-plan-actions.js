import { saveStageData } from "../../../shared/map-api.js";

export class RegionPlanActions {
  constructor({
    planController,
    getMapId,
    getRegions,
    getSelectedIndex,
    getPlans,
    setStatus,
    applyEditorFields,
    getPlanConfig,
    resetPlanConfig,
  }) {
    this.planController = planController;
    this.getMapId = getMapId;
    this.getRegions = getRegions;
    this.getSelectedIndex = getSelectedIndex;
    this.getPlans = getPlans;
    this.setStatus = setStatus;
    this.applyEditorFields = applyEditorFields;
    this.getPlanConfig = getPlanConfig;
    this.resetPlanConfig = resetPlanConfig;
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
    await this.planController.calculate(
      this.getRegions()[this.getSelectedIndex()],
      this.getPlans(),
      this.getPlanConfig(),
    );
  }

  async savePlans() {
    try {
      await saveStageData(this.getMapId(), "stage5-map-region-shot-plans", {
        plans: this.getPlans(),
      });
      this.setStatus("Regional camera plans saved.");
    } catch (error) {
      this.setStatus(`Saving regional camera plans failed: ${error.message}`, true);
    }
  }
}
