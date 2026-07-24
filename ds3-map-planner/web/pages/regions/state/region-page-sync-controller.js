import { validatePrism, validateRegionGroups, activeRegionGroups } from "../geometry/region-geometry.js";
import { flattenPrisms, regionGroupForIndex } from "./region-state.js";

export class RegionPageSyncController {
  constructor({ state, ui, runtime }) {
    this.state = state;
    this.ui = ui;
    this.runtime = runtime;
    this.onRegionSelectionChange = null;
    this.selectedNavmeshes = [];
    this.mode = "navmesh";
    this.modeSelections = { navmesh: [], regions: { prisms: [], primary: null } };
  }

  setRegions() { throw new Error("Use RegionState.regionGroups."); }
  setSelectedIndex(index) { this.state.select(index); }
  getSelectedRegionIndices() { return [...this.state.selectedIndices]; }
  getSelectedNavmeshes() { return [...this.selectedNavmeshes]; }

  clearSelectedNavmesh() {
    this.selectedNavmeshes = [];
    this.modeSelections.navmesh = [];
    this.runtime.overlay.renderSelectedNavmeshes([]);
  }

  resetModeSelections() {
    this.modeSelections = { navmesh: [], regions: { prisms: [], primary: null } };
    this.selectedNavmeshes = [];
    this.state.select(-1);
    this.runtime.overlay.renderSelectedNavmeshes([]);
    this.runtime.setStage4FilterRegions([]);
  }

  setMode(mode) {
    const nextMode = ["navmesh", "regions", "test"].includes(mode) ? mode : "regions";
    if (nextMode !== this.mode) {
      this.rememberModeSelection(this.mode);
      this.clearVisibleSelection();
      this.mode = nextMode;
      this.restoreModeSelection(this.mode);
    }
    this.ui.setStage4Mode(this.mode);
    this.sync();
  }

  suspendModeSelection() { this.rememberModeSelection(this.mode); this.clearVisibleSelection(); this.sync(); }
  resumeModeSelection() { this.clearVisibleSelection(); this.restoreModeSelection(this.mode); this.sync(); }

  rememberModeSelection(mode) {
    if (mode === "navmesh") this.modeSelections.navmesh = [...this.selectedNavmeshes];
    if (mode === "regions") {
      this.modeSelections.regions = {
        prisms: [...this.state.selectedPrisms],
        primary: this.state.primaryPrism,
      };
    }
  }

  clearVisibleSelection() {
    this.selectedNavmeshes = [];
    this.runtime.overlay.renderSelectedNavmeshes([]);
    this.state.select(-1);
    this.runtime.setStage4FilterRegions([]);
  }

  restoreModeSelection(mode) {
    if (mode === "navmesh") {
      this.selectedNavmeshes = this.modeSelections.navmesh.filter((mesh) => mesh?.isMesh && mesh.parent);
      this.runtime.overlay.renderSelectedNavmeshes(this.selectedNavmeshes);
    } else if (mode === "regions") {
      const snapshot = this.modeSelections.regions;
      this.state.restorePrismSelection(snapshot.prisms, snapshot.primary);
    }
  }

  createInputCallbacks() {
    return {
      getSelectedRegion: (index = this.state.selectedIndex) => this.state.regions[index] || null,
      getSelectedIndex: () => this.state.selectedIndex,
      isEditing: () => this.mode === "regions" && this.state.selectedIndex >= 0,
      onPreview: () => this.previewRegionEdit(),
      onCommit: () => this.commitGeometryEdit(),
      onInvalid: (region, before) => this.revertInvalidEdit(region, before),
      onRegion: (index, options) => this.selectRegion(index, options),
      onStage5Region: (index, options) => this.selectStage5Region(index, options),
      onNav: (mesh, options) => this.selectNavmesh(mesh, options),
      onEmpty: () => this.clearCurrentSelection(),
      getStage4Mode: () => this.mode,
      getSelectionMode: () => this.mode === "navmesh" ? "navmesh" : "region",
    };
  }

  redraw() {
    this.runtime.overlay.redraw({
      regions: this.state.regions,
      selectedIndices: this.state.selectedIndices,
      groupedIndices: this.groupedSelectionIndices(),
      primaryIndex: this.state.selectedIndex,
    });
    this.runtime.updateRegionFillVisibility();
  }

  previewRegionEdit() {
    this.updateFilterRegions();
    this.runtime.overlay.redrawRegion({
      region: this.state.selectedRegion,
      index: this.state.selectedIndex,
      selectedIndices: this.state.selectedIndices,
      groupedIndices: this.groupedSelectionIndices(),
    });
    this.runtime.updateRegionFillVisibility();
  }

  commitGeometryEdit() {
    const descriptor = this.state.descriptorForPrism(this.state.primaryPrism);
    if (descriptor) this.state.touchGroup(descriptor.group);
    this.sync();
  }

  groupedSelectionIndices() {
    const grouped = new Set();
    for (const index of this.state.selectedIndices) {
      for (const groupedIndex of regionGroupForIndex(null, this.state.regionGroups, index)) grouped.add(groupedIndex);
    }
    return [...grouped];
  }

  updateActiveRegions(position) {
    const groups = activeRegionGroups(this.state.regionGroups, position);
    this.runtime.overlay.setActiveGroupUuids(groups.map((group) => group.uuid));
    this.redraw();
    return groups.map((group) => ({
      name: group.name,
      groupUuid: group.uuid,
      prisms: group.prisms,
    }));
  }

  sync() {
    this.updateFilterRegions();
    this.ui.render({
      regionGroups: this.state.regionGroups,
      selectedPrisms: this.state.selectedPrisms,
      primaryPrism: this.state.primaryPrism,
      mode: this.mode,
      plans: this.state.plans,
      planningTargetKey: this.state.planningTargetKey,
      onSelect: (index, options) => this.selectRegion(index, options),
      onSelectGroup: (uuid) => this.selectGroup(uuid),
    });
    this.runtime.setCameraPlan(this.validSelectedPlan());
    this.redraw();
  }

  validSelectedPlan() {
    if (this.state.planningTargetKey === "fallback") {
      return this.state.plans.find((plan) => plan.kind === "fallback") || null;
    }
    const uuid = this.state.planningTargetKey.replace("region_group:", "");
    const group = this.state.regionGroups.find((item) => item.uuid === uuid);
    if (!group) return null;
    return this.state.plans.find((plan) =>
      plan.kind === "region_group" && plan.region_group_uuid === group.uuid &&
      plan.group_last_updated === group.last_updated) || null;
  }

  selectRegion(index, { focusRight = true, toggle = false } = {}) {
    if (this.mode !== "regions") return;
    const previous = this.state.primaryPrism;
    if (toggle) this.state.toggleSelected(index); else this.state.select(index);
    if (previous !== this.state.primaryPrism) this.onRegionSelectionChange?.(this.state.selectedRegion);
    this.rememberModeSelection("regions");
    if (this.state.selectedRegion) this.runtime.focusRegion(this.state.selectedRegion, { focusRight });
    this.sync();
  }

  selectGroup(uuid) {
    if (this.mode !== "regions") return;
    const group = this.state.regionGroups.find((item) => item.uuid === uuid);
    if (!group) return;
    this.state.restorePrismSelection(group.prisms, group.prisms.at(-1));
    this.rememberModeSelection("regions");
    this.runtime.focusRegions(group.prisms, { focusRight: false });
    this.sync();
  }

  selectNavmesh(mesh, { toggle = false } = {}) {
    if (this.mode !== "navmesh") return;
    this.state.select(-1);
    const index = this.selectedNavmeshes.indexOf(mesh);
    if (toggle) index >= 0 ? this.selectedNavmeshes.splice(index, 1) : this.selectedNavmeshes.push(mesh);
    else this.selectedNavmeshes = [mesh];
    this.modeSelections.navmesh = [...this.selectedNavmeshes];
    this.runtime.overlay.renderSelectedNavmeshes(this.selectedNavmeshes);
    this.runtime.focusNavmeshSelection(this.selectedNavmeshes);
    this.sync();
  }

  selectStage5Region(index, { focusRight = false } = {}) {
    if (index < 0) {
      this.state.planningTargetKey = "fallback";
      this.state.select(-1);
    } else {
      const descriptor = flattenPrisms(this.state.regionGroups)[index];
      if (!descriptor) return;
      this.state.planningTargetKey = `region_group:${descriptor.group.uuid}`;
      this.state.restorePrismSelection(descriptor.group.prisms, descriptor.prism);
    }
    if (this.state.selectedRegion) this.runtime.focusRegion(this.state.selectedRegion, { focusRight });
    this.onRegionSelectionChange?.(this.state.selectedRegion);
    this.sync();
  }

  selectPlanTarget(key) {
    if (key === "fallback") {
      this.state.planningTargetKey = "fallback";
      this.state.select(-1);
    } else {
      const uuid = String(key).replace("region_group:", "");
      const group = this.state.regionGroups.find((item) => item.uuid === uuid);
      if (!group) return;
      this.state.planningTargetKey = `region_group:${uuid}`;
      this.state.restorePrismSelection(group.prisms, group.prisms[0]);
    }
    this.onRegionSelectionChange?.(this.state.selectedRegion);
    this.sync();
  }

  ensureStage5Selection() {
    const key = this.state.planningTargetKey;
    const validKey = key === "fallback" || this.state.regionGroups.some((group) => key === `region_group:${group.uuid}`)
      ? key
      : this.state.regionGroups[0]
      ? `region_group:${this.state.regionGroups[0].uuid}`
      : "fallback";
    this.selectPlanTarget(validKey);
  }

  clearCurrentSelection() {
    if (this.mode === "navmesh") this.clearSelectedNavmesh();
    else if (this.mode === "regions") { this.state.select(-1); this.rememberModeSelection("regions"); }
    this.sync();
  }

  applyEditorFields() {
    const descriptor = this.state.descriptorForPrism(this.state.primaryPrism);
    if (!descriptor) return true;
    const editor = this.ui.readEditor();
    const draft = { ...descriptor.prism, ymin: editor.ymin, ymax: editor.ymax };
    const error = validatePrism(draft);
    if (error) { this.ui.status(error, true); return false; }
    const nameChanged = descriptor.group.name !== editor.name;
    const geometryChanged = descriptor.prism.ymin !== draft.ymin || descriptor.prism.ymax !== draft.ymax;
    if (!editor.name.trim()) { this.ui.status("Region group name is required.", true); return false; }
    const before = {
      name: descriptor.group.name,
      lastUpdated: descriptor.group.last_updated,
      ymin: descriptor.prism.ymin,
      ymax: descriptor.prism.ymax,
    };
    descriptor.group.name = editor.name;
    Object.assign(descriptor.prism, draft);
    if (nameChanged || geometryChanged) this.state.touchGroup(descriptor.group);
    const groupError = validateRegionGroups(this.state.regionGroups);
    if (groupError) {
      descriptor.group.name = before.name;
      descriptor.group.last_updated = before.lastUpdated;
      descriptor.prism.ymin = before.ymin;
      descriptor.prism.ymax = before.ymax;
      this.ui.status(groupError, true);
      return false;
    }
    return true;
  }

  updateFilterRegions() {
    const group = this.mode === "regions"
      ? this.state.descriptorForPrism(this.state.primaryPrism)?.group
      : null;
    this.runtime.setStage4FilterRegions(group?.prisms || []);
  }

  revertInvalidEdit(region, before) {
    if (!region || !Array.isArray(before)) return false;
    const validationError = validatePrism(region);
    if (validationError === null) return false;
    region.polygon_xz = before;
    this.ui.status(`Invalid polygon edit was reverted: ${validationError}`, true);
    return true;
  }
}
