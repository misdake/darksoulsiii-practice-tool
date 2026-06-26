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
  }) {
    this.navGroup = navGroup;
    this.missingPoints = missingPoints;
    this.getMapId = getMapId;
    this.getRegions = getRegions;
    this.setRegions = setRegions;
    this.getSelectedIndex = getSelectedIndex;
    this.setSelectedIndex = setSelectedIndex;
    this.removeSelectedRegion = removeSelectedRegion;
    this.getEditing = getEditing;
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
      onEdit: () => this.toggleEditRegion(),
      onDelete: () => this.deleteSelectedRegion(),
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

  toggleEditRegion() {
    if (this.getSelectedIndex() < 0) {
      this.setStatus("Select a region first.", true);
      return;
    }
    this.setEditing(!this.getEditing());
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

  async saveRegions() {
    this.applyEditorFields();
    const regions = this.getRegions();
    const error = validateRegions(regions);
    if (error) {
      this.setStatus(error, true);
      return;
    }

    await saveStageData(this.getMapId(), "stage4-map-regions", { regions });
    this.setStatus("Saved.");
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
