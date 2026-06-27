import { saveStageData } from "../../../shared/map-api.js";
import { validateRegions } from "../geometry/region-geometry.js";
import {
  buildAutoRegions,
  createRegionFromMeshes,
} from "../assets/region-navmesh-utils.js";

export class RegionStage4Actions {
  constructor({
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
  }) {
    this.navGroup = navGroup;
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
    this.setEditing = setEditing;
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
      onGroupRegions: () => this.groupSelectedRegionsAction(),
      onSave: () => this.saveRegions(),
      onClear: () => this.clearRegions(),
      onCalculateRegions: () => this.calculateRegions(),
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
    regions.push(createRegionFromMeshes(selectedNavmeshes, regions.length));
    this.setSelectionMode("region");
    this.setSelectedIndex(regions.length - 1);
    this.setEditing(true);
    this.sync();
  }

  deleteSelectedRegion() {
    const selected = this.getSelectedIndex();
    if (selected < 0) {
      return;
    }

    this.setSelectedIndex(selected);
    this.removeSelectedRegion();
    this.setSelectedIndex(this.getSelectedIndex());
    this.setEditing(false);
    this.sync();
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
    this.setEditing(false);
    this.missingPoints.clear();
    this.sync();
    this.setStatus("Regions cleared. Save to persist the change.");
  }

  async calculateRegions() {
    if (
      this.getRegions().length &&
      !(await this.confirm("Replace all unsaved map regions?"))
    ) {
      return;
    }

    const regions = buildAutoRegions(this.navGroup);
    this.setRegions(regions);
    this.setRegionGroups([]);
    this.setSelectedIndex(regions.length ? 0 : -1);
    this.setEditing(Boolean(regions.length));
    this.sync();
    this.setStatus(`Calculated ${regions.length} regions. Save to persist.`);
  }

  applyEditorChange() {
    this.applyEditorFields();
    this.sync();
  }
}
