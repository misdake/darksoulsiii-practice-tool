import { RegionStage4Actions } from "./region-stage4-actions.js";
import { RegionTestActions } from "./region-test-actions.js";
import { RegionPlanActions } from "./region-plan-actions.js";

export class RegionActionsController {
  constructor({
    missingPoints,
    planController,
    getMapId,
    getRegions,
    setRegions,
    getRegionGroups,
    setRegionGroups,
    groupSelectedRegions,
    getSelectedIndex,
    getSelectedRegionIndices,
    setSelectedIndex,
    removeSelectedRegion,
    setSelectionMode,
    getSelectedNavmeshes,
    getPlans,
    confirm,
    setStatus,
    sync,
    applyEditorFields,
    getPlanConfig,
    resetPlanConfig,
    focusGamePoint,
    toggleTestCameraMode,
    navigateBack,
  }) {
    this.stage4 = new RegionStage4Actions({
      missingPoints,
      getMapId,
      getRegions,
      setRegions,
      getRegionGroups,
      setRegionGroups,
      groupSelectedRegions,
      getSelectedIndex,
      getSelectedRegionIndices,
      setSelectedIndex,
      removeSelectedRegion,
      setSelectionMode,
      getSelectedNavmeshes,
      confirm,
      setStatus,
      sync,
      applyEditorFields,
    });
    this.test = new RegionTestActions({
      missingPoints,
      getRegions,
      setStatus,
      applyEditorFields,
      focusGamePoint,
      toggleTestCameraMode,
    });
    this.plan = new RegionPlanActions({
      planController,
      getMapId,
      getRegions,
      getSelectedIndex,
      getPlans,
      setStatus,
      applyEditorFields,
      getPlanConfig,
      resetPlanConfig,
    });
    this.navigateBack = navigateBack;
  }

  createHandlers() {
    return {
      ...this.stage4.handlers(),
      ...this.test.handlers(),
      ...this.plan.handlers(),
      onBack: () => this.navigateBack(),
    };
  }
}
