import { RegionStage4Actions } from "./region-stage4-actions.js";
import { RegionStage5Actions } from "./region-stage5-actions.js";
import { RegionStage6Actions } from "./region-stage6-actions.js";

export class RegionActionsController {
  constructor({
    navGroup,
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
    setEditing,
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
    toggleStage5Mode,
    isStage5OutdoorRegionEnabled,
    navigateBack,
  }) {
    this.stage4 = new RegionStage4Actions({
      navGroup,
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
      setEditing,
      setSelectionMode,
      getSelectedNavmeshes,
      confirm,
      setStatus,
      sync,
      applyEditorFields,
    });
    this.stage5 = new RegionStage5Actions({
      navGroup,
      missingPoints,
      getRegions,
      getRegionGroups,
      setStatus,
      applyEditorFields,
      focusGamePoint,
      toggleStage5Mode,
      isOutdoorRegionEnabled: isStage5OutdoorRegionEnabled,
    });
    this.stage6 = new RegionStage6Actions({
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
      ...this.stage5.handlers(),
      ...this.stage6.handlers(),
      onBack: () => this.navigateBack(),
    };
  }
}
