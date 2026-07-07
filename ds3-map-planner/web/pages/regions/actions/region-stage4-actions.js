import { saveStageData } from "../../../shared/map-api.js";
import { validateRegionGroups } from "../geometry/region-geometry.js";
import { createRegionFromMeshes } from "../assets/region-navmesh-utils.js";

export class RegionStage4Actions {
  constructor({
    state,
    missingPoints,
    getMapId,
    setSelectionMode,
    getSelectedNavmeshes,
    confirm,
    setStatus,
    sync,
    applyEditorFields,
  }) {
    this.state = state;
    this.missingPoints = missingPoints;
    this.getMapId = getMapId;
    this.setSelectionMode = setSelectionMode;
    this.getSelectedNavmeshes = getSelectedNavmeshes;
    this.confirm = confirm;
    this.setStatus = setStatus;
    this.sync = sync;
    this.applyEditorFields = applyEditorFields;
  }

  handlers() {
    return {
      onNew: () => this.createRegion(),
      onDelete: () => this.deleteSelectedRegion(),
      onSplitRegionHeight: () => this.splitSelectedRegionHeight(),
      onGroupRegions: () => this.groupSelectedRegionsAction(),
      onSave: () => this.saveRegions(),
      onClear: () => this.clearRegions(),
      onEditorChange: () => this.applyEditorChange(),
    };
  }

  createRegion() {
    const selectedNavmeshes = this.getSelectedNavmeshes();
    if (!selectedNavmeshes.length) {
      this.setStatus("Select one or more navmesh splits in the right viewport first.", true);
      return;
    }
    const prism = createRegionFromMeshes(selectedNavmeshes, this.state.regions.length);
    delete prism.name;
    this.state.createGroup([prism]);
    this.setSelectionMode("regions");
    this.state.restorePrismSelection([prism], prism);
    this.sync();
  }

  deleteSelectedRegion() {
    if (!this.state.selectedPrisms.length) return;
    this.state.removeSelected();
    this.sync();
  }

  splitSelectedRegionHeight() {
    if (!this.applyEditorFields()) {
      this.sync();
      return;
    }
    const result = this.state.splitSelectedHeight();
    if (!result) {
      this.setStatus("Select a prism to split first.", true);
      return;
    }
    this.sync();
    this.setStatus(`Split prism at Y ${result.upper.ymin.toFixed(2)}. Save to persist.`);
  }

  groupSelectedRegionsAction() {
    if (!this.state.selectedPrisms.length) {
      this.setStatus("Select at least one prism first.", true);
      return;
    }
    if (!this.state.groupSelectedRegions()) {
      this.setStatus("The selected prisms are already in the requested group.");
      return;
    }
    this.sync();
    this.setStatus("Updated prism grouping. Save to persist.");
  }

  async saveRegions() {
    if (!this.applyEditorFields()) {
      this.sync();
      return;
    }
    const error = validateRegionGroups(this.state.regionGroups);
    if (error) {
      this.setStatus(error, true);
      return;
    }
    try {
      await saveStageData(this.getMapId(), "stage4-map-regions", {
        region_groups: this.state.regionGroups,
      });
      this.setStatus("Saved.");
    } catch (error) {
      this.setStatus(`Saving regions failed: ${error.message}`, true);
    }
  }

  async clearRegions() {
    if (!this.state.regionGroups.length) return;
    if (!(await this.confirm("Clear all unsaved region groups?"))) return;
    this.state.setRegionGroups([]);
    this.missingPoints.clear();
    this.sync();
    this.setStatus("Region groups cleared. Save to persist the change.");
  }

  applyEditorChange() {
    this.applyEditorFields();
    this.sync();
  }
}
