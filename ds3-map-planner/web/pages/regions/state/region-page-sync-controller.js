import { validateRegions } from "../geometry/region-geometry.js";

export class RegionPageSyncController {
  constructor({ state, ui, runtime }) {
    this.state = state;
    this.ui = ui;
    this.runtime = runtime;
    this.selectedNavmeshes = [];
    this.selectionMode = "region";
  }

  setRegions(regions) {
    this.state.regions = Array.isArray(regions) ? regions : [];
  }

  setPlans(plans) {
    this.state.plans = Array.isArray(plans) ? plans : [];
  }

  setSelectedIndex(index) {
    this.state.select(index);
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
    this.runtime.overlay.redraw(this.state.regions, this.state.selectedIndex);
  }

  updateActiveRegions(position) {
    const activeRegions = this.runtime.overlay.updateActive(
      this.state.regions,
      position,
      () => this.redraw(),
    );
    this.ui.renderActiveRegions(activeRegions);
    return activeRegions;
  }

  sync() {
    this.ui.render({
      regions: this.state.regions,
      selectedIndex: this.state.selectedIndex,
      selectionMode: this.selectionMode,
      plans: this.state.plans,
      onSelect: (index) => this.selectRegion(index),
    });
    this.redraw();
  }

  selectRegion(index, { focusRight = true } = {}) {
    if (this.selectionMode !== "region") {
      return;
    }
    this.clearSelectedNavmesh();
    this.setSelectedIndex(index);
    this.state.editing = this.state.selectedIndex >= 0;
    this.runtime.focusRegion(this.state.selectedRegion, { focusRight });
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
    Object.assign(region, this.ui.readEditor());
  }

  revertInvalidEdit(region, before) {
    if (!validateRegions([region])) return false;
    region.polygon_xz = before;
    this.ui.status("Invalid polygon edit was reverted.", true);
    return true;
  }
}
