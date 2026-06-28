import { validateRegions } from "../geometry/region-geometry.js";
import { regionGroupForIndex } from "./region-state.js";

export class RegionPageSyncController {
  constructor({ state, ui, runtime }) {
    this.state = state;
    this.ui = ui;
    this.runtime = runtime;
    this.onRegionSelectionChange = null;
    this.selectedNavmeshes = [];
    this.mode = "regions";
    this.stage4FilterRegion = null;
  }

  setRegions(regions) {
    this.state.setRegions(regions);
  }

  setSelectedIndex(index) {
    this.state.select(index);
  }

  getSelectedRegionIndices() {
    return [...this.state.selectedIndices];
  }

  getSelectedNavmeshes() {
    return [...this.selectedNavmeshes];
  }

  clearSelectedNavmesh() {
    this.selectedNavmeshes = [];
    this.runtime.overlay.renderSelectedNavmeshes([]);
  }

  setMode(mode) {
    const nextMode = ["navmesh", "regions", "test"].includes(mode)
      ? mode
      : "regions";
    if (this.state.selectedRegion) {
      this.stage4FilterRegion = this.state.selectedRegion;
    }
    this.mode = nextMode;
    this.ui.setStage4Mode(this.mode);
    if (this.mode === "navmesh" || this.mode === "test") {
      this.setSelectedIndex(-1);
    } else {
      this.clearSelectedNavmesh();
    }
    this.sync();
  }

  createInputCallbacks() {
    return {
      getSelectedRegion: (index = this.state.selectedIndex) =>
        this.state.regions[index] || null,
      getSelectedIndex: () => this.state.selectedIndex,
      isEditing: () =>
        this.mode === "regions" && this.state.selectedIndex >= 0,
      onPreview: () => this.previewRegionEdit(),
      onCommit: () => this.sync(),
      onInvalid: (region, before) => this.revertInvalidEdit(region, before),
      onRegion: (index, options) => this.selectRegion(index, options),
      onStage5Region: (index, options) =>
        this.selectStage5Region(index, options),
      onNav: (mesh, options) => this.selectNavmesh(mesh, options),
      onEmpty: () => this.clearCurrentSelection(),
      getStage4Mode: () => this.mode,
      getSelectionMode: () => (this.mode === "navmesh" ? "navmesh" : "region"),
    };
  }

  redraw() {
    const groupedIndices = this.groupedSelectionIndices();
    this.runtime.overlay.redraw({
      regions: this.state.regions,
      selectedIndices: this.state.selectedIndices,
      groupedIndices,
      primaryIndex: this.state.selectedIndex,
    });
    this.runtime.updateRegionFillVisibility();
  }

  previewRegionEdit() {
    this.reconcileStage4FilterRegion();
    this.runtime.setStage4FilterRegion(this.stage4FilterRegion);
    this.runtime.overlay.redrawRegion({
      region: this.state.selectedRegion,
      index: this.state.selectedIndex,
      selectedIndices: this.state.selectedIndices,
      groupedIndices: this.groupedSelectionIndices(),
    });
    this.runtime.updateRegionFillVisibility();
  }

  groupedSelectionIndices() {
    const groupedIndices = new Set();
    for (const index of this.state.selectedIndices) {
      for (const groupedIndex of regionGroupForIndex(
        this.state.regions,
        this.state.regionGroups,
        index,
      )) {
        groupedIndices.add(groupedIndex);
      }
    }
    return [...groupedIndices];
  }

  updateActiveRegions(position) {
    const activeRegions = this.runtime.overlay.updateActive(
      this.state.regions,
      position,
      () => this.redraw(),
    );
    const expandedRegions = this.expandRegionsToGroups(activeRegions);
    return expandedRegions;
  }

  sync() {
    this.reconcileStage4FilterRegion();
    this.runtime.setStage4FilterRegion(this.stage4FilterRegion);
    this.ui.render({
      regions: this.state.regions,
      regionGroups: this.state.regionGroups,
      selectedIndex: this.state.selectedIndex,
      selectedIndices: this.state.selectedIndices,
      mode: this.mode,
      plans: this.state.plans,
      onSelect: (index, options) => this.selectRegion(index, options),
    });
    this.runtime.setCameraPlan(
      this.state.plans.find(
        (plan) => plan.region_name === this.state.selectedRegion?.name,
      ),
    );
    this.redraw();
  }

  selectRegion(index, { focusRight = true, toggle = false } = {}) {
    if (this.mode !== "regions") {
      return;
    }
    this.clearSelectedNavmesh();
    const previousIndex = this.state.selectedIndex;
    if (toggle) {
      this.state.toggleSelected(index);
    } else {
      this.setSelectedIndex(index);
    }
    if (previousIndex !== this.state.selectedIndex) {
      this.onRegionSelectionChange?.(this.state.selectedRegion);
    }
    this.stage4FilterRegion = this.state.selectedRegion;
    if (this.state.selectedRegion) {
      this.runtime.focusRegion(this.state.selectedRegion, { focusRight });
    }
    this.sync();
  }

  selectNavmesh(mesh, { toggle = false } = {}) {
    if (this.mode !== "navmesh") {
      return;
    }
    this.setSelectedIndex(-1);
    if (toggle) {
      const index = this.selectedNavmeshes.indexOf(mesh);
      if (index >= 0) {
        this.selectedNavmeshes.splice(index, 1);
      } else {
        this.selectedNavmeshes.push(mesh);
      }
    } else {
      this.selectedNavmeshes = [mesh];
    }

    this.runtime.overlay.renderSelectedNavmeshes(this.selectedNavmeshes);
    this.runtime.focusNavmeshSelection(this.selectedNavmeshes);
    this.ui.status(
      this.selectedNavmeshes.length
        ? `Selected ${this.selectedNavmeshes.length} navmesh split(s).`
        : "No navmesh splits selected.",
    );
    this.sync();
  }

  selectStage5Region(index, { focusRight = false } = {}) {
    const previousIndex = this.state.selectedIndex;
    this.clearSelectedNavmesh();
    this.state.select(index);
    if (previousIndex !== this.state.selectedIndex) {
      this.onRegionSelectionChange?.(this.state.selectedRegion);
    }
    if (this.state.selectedRegion) {
      this.runtime.focusRegion(this.state.selectedRegion, { focusRight });
    }
    this.sync();
  }

  ensureStage5Selection() {
    if (this.state.selectedIndex < 0 && this.state.regions.length) {
      this.selectStage5Region(0, { focusRight: false });
    }
  }

  clearCurrentSelection() {
    if (this.mode === "navmesh") {
      this.clearSelectedNavmesh();
      this.ui.status("No navmesh splits selected.");
    } else if (this.mode === "regions") {
      this.setSelectedIndex(-1);
      this.stage4FilterRegion = null;
    }
    this.sync();
  }

  applyEditorFields() {
    const region = this.state.selectedRegion;
    if (!region) return true;
    const oldName = region.name;
    const draft = { ...region, ...this.ui.readEditor() };
    const nextRegions = this.state.regions.map((candidate, index) =>
      index === this.state.selectedIndex ? draft : candidate,
    );
    const error = validateRegions(nextRegions);
    if (error) {
      this.ui.status(error, true);
      return false;
    }
    Object.assign(region, draft);
    this.state.renameRegion(oldName, draft.name);
    this.state.setRegionGroups(this.state.regionGroups);
    return true;
  }

  reconcileStage4FilterRegion() {
    this.stage4FilterRegion =
      this.mode === "regions" ? this.state.selectedRegion : null;
  }

  revertInvalidEdit(region, before) {
    if (!region || !Array.isArray(before)) return false;
    if (!validateRegions([region])) return false;
    region.polygon_xz = before;
    this.ui.status("Invalid polygon edit was reverted.", true);
    return true;
  }

  expandRegionsToGroups(activeRegions) {
    const result = [];
    const names = new Set();
    const activeNames = new Set(activeRegions.map((region) => region.name));
    const groupedNames = new Set(
      this.state.regionGroups.flatMap((group) => group.regions),
    );

    for (const group of this.state.regionGroups) {
      if (!group.regions.some((name) => activeNames.has(name))) {
        continue;
      }
      for (const name of group.regions) {
        const region = this.state.regions.find((item) => item.name === name);
        if (region && !names.has(region.name)) {
          names.add(region.name);
          result.push(region);
        }
      }
    }

    for (const region of activeRegions) {
      if (!groupedNames.has(region.name) && !names.has(region.name)) {
        names.add(region.name);
        result.push(region);
      }
    }

    return result.sort(
      (a, b) =>
        a.ymin - b.ymin ||
        this.state.regions.indexOf(a) - this.state.regions.indexOf(b),
    );
  }
}
