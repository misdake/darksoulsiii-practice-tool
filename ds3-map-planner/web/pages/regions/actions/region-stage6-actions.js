import { saveStageData } from "../../../shared/map-api.js";

export class RegionStage6Actions {
  constructor({
    planController,
    getMapId,
    getRegions,
    getSelectedIndex,
    getPlans,
    setPlans,
    setStatus,
    applyEditorFields,
  }) {
    this.planController = planController;
    this.getMapId = getMapId;
    this.getRegions = getRegions;
    this.getSelectedIndex = getSelectedIndex;
    this.getPlans = getPlans;
    this.setPlans = setPlans;
    this.setStatus = setStatus;
    this.applyEditorFields = applyEditorFields;
  }

  handlers() {
    return {
      onCalculatePlan: () => this.calculatePlan(),
      onSavePlans: () => this.savePlans(),
    };
  }

  async calculatePlan() {
    this.applyEditorFields();
    const plans = await this.planController.calculate(
      this.getRegions()[this.getSelectedIndex()],
      this.getPlans(),
    );
    this.setPlans(plans);
  }

  async savePlans() {
    await saveStageData(this.getMapId(), "stage6-map-region-shot-plans", {
      plans: this.getPlans(),
    });
    this.setStatus("Regional camera plans saved.");
  }
}
