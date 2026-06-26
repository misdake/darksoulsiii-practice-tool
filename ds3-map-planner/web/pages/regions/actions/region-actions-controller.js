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
    getSelectedIndex,
    setSelectedIndex,
    removeSelectedRegion,
    getEditing,
    setEditing,
    setSelectionMode,
    getSelectedNavmeshes,
    getPlans,
    setPlans,
    getPreviewPosition,
    confirm,
    setStatus,
    sync,
    applyEditorFields,
    updateActiveRegions,
    setGamePosition,
    focusGamePoint,
    toggleStage5Mode,
    navigateBack,
  }) {
    this.stage4 = new RegionStage4Actions({
      navGroup,
      missingPoints,
      getMapId,
      getRegions,
      setRegions,
      getSelectedIndex,
      setSelectedIndex,
      removeSelectedRegion,
      getEditing,
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
      getPreviewPosition,
      setStatus,
      applyEditorFields,
      updateActiveRegions,
      setGamePosition,
      focusGamePoint,
      toggleStage5Mode,
    });
    this.stage6 = new RegionStage6Actions({
      planController,
      getMapId,
      getRegions,
      getSelectedIndex,
      getPlans,
      setPlans,
      setStatus,
      applyEditorFields,
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
