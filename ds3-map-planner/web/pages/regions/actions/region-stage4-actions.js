import { saveStageData } from "../../../shared/map-api.js";
import {
  splitRegionHeight,
  validateRegions,
} from "../geometry/region-geometry.js";
import { createRegionFromMeshes } from "../assets/region-navmesh-utils.js";
import { nextRegionName } from "../state/region-state.js";

export class RegionStage4Actions {
  constructor({
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
  }) {
    this.missingPoints = missingPoints;
    this.getMapId = getMapId;
    this.getRegions = getRegions;
    this.setRegions = setRegions;
    this.getRegionGroups = getRegionGroups;
    this.setRegionGroups = setRegionGroups;
    this.groupSelectedRegions = groupSelectedRegions;
    this.getSelectedIndex = getSelectedIndex;
    this.getSelectedRegionIndices = getSelectedRegionIndices;
    this.setSelectedIndex = setSelectedIndex;
    this.removeSelectedRegion = removeSelectedRegion;
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
      this.setStatus(
        "Select one or more navmesh splits in the right viewport first.",
        true,
      );
      return;
    }

    const regions = this.getRegions();
    const region = createRegionFromMeshes(selectedNavmeshes, regions.length);
    region.name = nextRegionName(regions);
    regions.push(region);
    this.setSelectionMode("regions");
    this.setSelectedIndex(regions.length - 1);
    this.sync();
  }

  deleteSelectedRegion() {
    const selected = this.getSelectedIndex();
    if (selected < 0) {
      return;
    }

    this.removeSelectedRegion();
    this.sync();
  }

  splitSelectedRegionHeight() {
    if (!this.applyEditorFields()) {
      this.sync();
      return;
    }
    const selected = this.getSelectedIndex();
    const regions = this.getRegions();
    const region = regions[selected];
    if (!region) {
      this.setStatus("Select a region to split first.", true);
      return;
    }

    const newName = nextRegionName(regions);
    const { lower, upper } = splitRegionHeight(region, newName);
    regions.splice(selected, 1, lower, upper);
    this.setSelectedIndex(selected + 1);
    this.sync();
    this.setStatus(
      `Split region at Y ${upper.ymin.toFixed(2)}. Save to persist.`,
    );
  }

  groupSelectedRegionsAction() {
    if (!this.getSelectedRegionIndices().length) {
      this.setStatus("Select at least one region first.", true);
      return;
    }
    if (!this.groupSelectedRegions()) {
      this.setStatus("Select at least one region first.", true);
      return;
    }
    this.sync();
    this.setStatus(
      this.getSelectedRegionIndices().length > 1
        ? "Grouped selected regions. Save to persist."
        : "Region split into its own group. Save to persist.",
    );
  }

  async saveRegions() {
    if (!this.applyEditorFields()) {
      this.sync();
      return;
    }
    const regions = this.getRegions();
    const error = validateRegions(regions);
    if (error) {
      this.setStatus(error, true);
      return;
    }

    try {
      await saveStageData(this.getMapId(), "stage4-map-regions", {
        regions,
        region_groups: this.getRegionGroups(),
      });
      this.setStatus("Saved.");
    } catch (saveError) {
      this.setStatus(`Saving regions failed: ${saveError.message}`, true);
    }
  }

  async clearRegions() {
    const regions = this.getRegions();
    if (!regions.length) {
      return;
    }
    if (!(await this.confirm("Clear all unsaved map regions?"))) {
      return;
    }

    this.setRegions([]);
    this.setRegionGroups([]);
    this.setSelectedIndex(-1);
    this.missingPoints.clear();
    this.sync();
    this.setStatus("Regions cleared. Save to persist the change.");
  }

  applyEditorChange() {
    this.applyEditorFields();
    this.sync();
  }
}
