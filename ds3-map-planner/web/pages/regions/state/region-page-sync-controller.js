import { validateRegions } from "../geometry/region-geometry.js";
import { regionGroupForIndex } from "./region-state.js";

export class RegionPageSyncController {
  constructor({ state, ui, runtime }) {
    this.state = state;
    this.ui = ui;
    this.runtime = runtime;
    this.selectedNavmeshes = [];
    this.selectionMode = "region";
  }

  setRegions(regions) {
    this.state.setRegions(regions);
  }

  setPlans(plans) {
    this.state.plans = Array.isArray(plans) ? plans : [];
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

  setSelectionMode(mode) {
    this.selectionMode = mode === "navmesh" ? "navmesh" : "region";
    this.ui.setStage4SelectionMode(this.selectionMode);
    if (this.selectionMode === "navmesh") {
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
        this.selectionMode === "region" && this.state.selectedIndex >= 0,
      onChange: () => this.sync(),
      onInvalid: (region, before) => this.revertInvalidEdit(region, before),
      onRegion: (index, options) => this.selectRegion(index, options),
      onNav: (mesh, options) => this.selectNavmesh(mesh, options),
      onEmpty: () => this.clearCurrentSelection(),
      getSelectionMode: () => this.selectionMode,
    };
  }

  redraw() {
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
    this.runtime.overlay.redraw({
      regions: this.state.regions,
      selectedIndices: this.state.selectedIndices,
      groupedIndices: [...groupedIndices],
      primaryIndex: this.state.selectedIndex,
    });
  }

  updateActiveRegions(position) {
    const activeRegions = this.runtime.overlay.updateActive(
      this.state.regions,
      position,
      () => this.redraw(),
    );
    const expandedRegions = this.expandRegionsToGroups(activeRegions);
    this.ui.renderActiveRegions(expandedRegions);
    return expandedRegions;
  }

  sync() {
    this.ui.render({
      regions: this.state.regions,
      regionGroups: this.state.regionGroups,
      selectedIndex: this.state.selectedIndex,
      selectedIndices: this.state.selectedIndices,
      selectionMode: this.selectionMode,
      plans: this.state.plans,
      onSelect: (index, options) => this.selectRegion(index, options),
    });
    this.redraw();
  }

  selectRegion(index, { focusRight = true, toggle = false } = {}) {
    if (this.selectionMode !== "region") {
      return;
    }
    this.clearSelectedNavmesh();
    if (toggle) {
      this.state.toggleSelected(index);
    } else {
      this.setSelectedIndex(index);
    }
    this.state.editing = this.state.selectedIndex >= 0;
    if (this.state.selectedRegion) {
      this.runtime.focusRegion(this.state.selectedRegion, { focusRight });
    }
    this.sync();
  }

  selectNavmesh(mesh, { toggle = false } = {}) {
    if (this.selectionMode !== "navmesh") {
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

  clearCurrentSelection() {
    if (this.selectionMode === "navmesh") {
      this.clearSelectedNavmesh();
      this.ui.status("No navmesh splits selected.");
    } else {
      this.setSelectedIndex(-1);
    }
    this.sync();
  }

  applyEditorFields() {
    const region = this.state.selectedRegion;
    if (!region) return;
    const oldName = region.name;
    Object.assign(region, this.ui.readEditor());
    this.state.renameRegion(oldName, region.name);
  }

  revertInvalidEdit(region, before) {
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
