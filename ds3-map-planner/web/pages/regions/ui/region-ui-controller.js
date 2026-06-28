import { createStatusReporter } from "../../../shared/status-reporter.js";
import { RegionConfirmDialog } from "./region-confirm-dialog.js";
import { RegionPanelRenderer } from "./region-panel-renderer.js";

export class RegionUiController {
  constructor(document) {
    this.document = document;
    this.byId = (id) => document.getElementById(id);
    this.mapSelect = this.byId("mapSelect");
    this.workControls = this.byId("regionWorkControls");
    this.progressWrap = this.byId("loadProgressWrap");
    this.progressText = this.byId("loadProgressText");
    this.progressPercent = this.byId("loadProgressPct");
    this.progressFill = this.byId("loadProgressFill");
    this.sharedMapDisplayControls = this.byId("sharedMapDisplayControls");
    this.showCollision = this.byId("showCollision");
    this.collisionOpacity = this.byId("collisionOpacity");
    this.collisionOpacityValue = this.byId("collisionOpacityValue");
    this.navmeshOpacity = this.byId("navmeshOpacity");
    this.navmeshOpacityValue = this.byId("navmeshOpacityValue");
    this.showOutdoorRegion = this.byId("showOutdoorRegion");
    this.clipSelectedRegion = this.byId("clipSelectedRegion");
    this.clipActiveRegions = this.byId("clipActiveRegions");
    this.recordMissingPoints = this.byId("recordMissingPoints");
    this.stage4ModeRadios = Array.from(
      document.querySelectorAll('input[name="stage4Mode"]'),
    );
    this.regionManagementFields = this.byId("regionManagementFields");
    this.navmeshFields = this.byId("navmeshFields");
    this.regionTestFields = this.byId("regionTestFields");
    this.status = createStatusReporter(this.byId("status"));
    this.confirmDialog = new RegionConfirmDialog(this.byId);
    this.panelRenderer = new RegionPanelRenderer({
      document,
      byId: this.byId,
    });
    this.stageRadios = Array.from(
      document.querySelectorAll('input[name="regionStage"]'),
    );
    this.stagePanels = Array.from(
      document.querySelectorAll("[data-region-stage-panel]"),
    );
    this.onStageChange = null;
    this.listeners = [];
  }

  get selectedMapId() {
    return this.mapSelect?.value || "";
  }

  getCanvasHost() {
    const placeholder = this.byId("map");
    const host = placeholder.parentElement;
    placeholder.remove();
    return host;
  }

  renderMapOptions(maps = []) {
    if (!this.mapSelect) return;
    this.mapSelect.replaceChildren(
      ...maps.map((map) =>
        new Option(map.display_name || map.map_id || map, map.map_id || map),
      ),
    );
  }

  beginMapLoading(mapId) {
    this.setLoading(true);
    this.setLoadProgress(`loading ${mapId}`, 0);
  }

  finishMapLoading() {
    this.setLoadProgress("loaded", 1);
    this.setLoading(false);
  }

  setLoading(loading) {
    if (this.workControls) {
      this.workControls.hidden = Boolean(loading);
    }
    if (this.progressWrap) {
      this.progressWrap.hidden = !loading;
    }
  }

  setLoadProgress(text, ratio) {
    if (!this.progressWrap) return;
    const value = Math.max(0, Math.min(1, Number(ratio) || 0));
    this.progressText.textContent = text;
    this.progressPercent.textContent = `${Math.round(value * 100)}%`;
    this.progressFill.style.width = `${value * 100}%`;
  }

  onMapChange(callback) {
    this.addListener(this.mapSelect, "change", callback);
  }

  bindActions({
    onNew,
    onDelete,
    onGroupRegions,
    onSave,
    onCalculatePlan,
    onCancelPlan,
    onResetPlanConfig,
    onSelectStage5Region,
    onSavePlans,
    onClear,
    onEditorChange,
    onToggleTestCameraMode,
    onRecheckMissing,
    onFocusMissing,
    onClearMissing,
    onBack,
    onFitCamera,
    onStageChange,
    onStage4ModeChange,
    onCollisionVisibleChange,
    onCollisionOpacityInput,
    onNavmeshOpacityInput,
    onClipSelectedRegionChange,
    onClipActiveRegionsChange,
    onRecordMissingPointsChange,
    onShowOutdoorRegionChange,
  }) {
    this.onStageChange = onStageChange;
    for (const radio of this.stageRadios) {
      this.addListener(radio, "change", () => {
        if (radio.checked) this.setActiveStage(Number(radio.value));
      });
    }
    this.addListener(this.byId("newBtn"), "click", onNew);
    this.addListener(this.byId("deleteBtn"), "click", onDelete);
    this.addListener(this.byId("groupRegionsBtn"), "click", onGroupRegions);
    this.addListener(this.byId("saveBtn"), "click", onSave);
    this.addListener(this.byId("calculatePlanBtn"), "click", onCalculatePlan);
    this.addListener(this.byId("cancelPlanBtn"), "click", onCancelPlan);
    this.addListener(this.byId("resetPlanConfigBtn"), "click", onResetPlanConfig);
    this.addListener(this.byId("stage5RegionSelect"), "change", () =>
      onSelectStage5Region?.(Number(this.byId("stage5RegionSelect").value)),
    );
    this.addListener(this.byId("savePlansBtn"), "click", onSavePlans);
    this.addListener(this.byId("clearBtn"), "click", onClear);
    for (const radio of this.stage4ModeRadios) {
      this.addListener(radio, "change", () => {
        if (radio.checked) {
          this.setStage4Mode(radio.value);
          onStage4ModeChange?.(radio.value);
        }
      });
    }
    this.addListener(this.byId("testModeBtn"), "click", onToggleTestCameraMode);
    this.addListener(this.byId("recheckMissingBtn"), "click", onRecheckMissing);
    this.addListener(this.byId("focusMissingBtn"), "click", onFocusMissing);
    this.addListener(this.byId("clearMissingBtn"), "click", onClearMissing);
    this.addListener(this.byId("backBtn"), "click", onBack);
    this.addListener(this.byId("fitCameraBtn"), "click", onFitCamera);
    this.addListener(this.showCollision, "change", () =>
      onCollisionVisibleChange?.(this.showCollision.checked),
    );
    this.addListener(this.collisionOpacity, "input", () => {
      const opacity = Number(this.collisionOpacity.value);
      this.setCollisionOpacity(opacity);
      onCollisionOpacityInput?.(opacity);
    });
    this.addListener(this.navmeshOpacity, "input", () => {
      const opacity = Number(this.navmeshOpacity.value);
      this.setNavmeshOpacity(opacity);
      onNavmeshOpacityInput?.(opacity);
    });
    this.addListener(this.clipSelectedRegion, "change", () =>
      onClipSelectedRegionChange?.(this.clipSelectedRegion.checked),
    );
    this.addListener(this.clipActiveRegions, "change", () =>
      onClipActiveRegionsChange?.(this.clipActiveRegions.checked),
    );
    this.addListener(this.recordMissingPoints, "change", () =>
      onRecordMissingPointsChange?.(this.recordMissingPoints.checked),
    );
    this.addListener(this.showOutdoorRegion, "change", () =>
      onShowOutdoorRegionChange?.(this.showOutdoorRegion.checked),
    );
    for (const id of ["name", "ymin", "ymax"]) {
      this.addListener(this.byId(id), "change", onEditorChange);
    }
    this.setActiveStage(this.currentStage());
    this.setStage4Mode(this.stage4Mode());
    onStage4ModeChange?.(this.stage4Mode());
    onCollisionVisibleChange?.(this.showCollision?.checked ?? true);
    const initialOpacity = Number(this.collisionOpacity?.value);
    this.setCollisionOpacity(initialOpacity);
    onCollisionOpacityInput?.(initialOpacity);
    const initialNavmeshOpacity = Number(this.navmeshOpacity?.value);
    this.setNavmeshOpacity(initialNavmeshOpacity);
    onNavmeshOpacityInput?.(initialNavmeshOpacity);
    onClipSelectedRegionChange?.(this.clipSelectedRegion?.checked ?? false);
    onClipActiveRegionsChange?.(this.clipActiveRegions?.checked ?? true);
    onRecordMissingPointsChange?.(this.recordMissingPoints?.checked ?? false);
    onShowOutdoorRegionChange?.(this.showOutdoorRegion?.checked ?? true);
  }

  currentStage() {
    const checked = this.stageRadios.find((radio) => radio.checked);
    return Number(checked?.value) || 4;
  }

  stage4Mode() {
    const checked = this.stage4ModeRadios.find(
      (radio) => radio.checked,
    );
    return ["navmesh", "regions", "test"].includes(checked?.value)
      ? checked.value
      : "regions";
  }

  setStage4Mode(mode) {
    const selectedMode = ["navmesh", "regions", "test"].includes(mode)
      ? mode
      : "regions";
    for (const radio of this.stage4ModeRadios) {
      radio.checked = radio.value === selectedMode;
    }
    this.regionManagementFields.hidden = selectedMode !== "regions";
    if (this.navmeshFields) {
      this.navmeshFields.hidden = selectedMode !== "navmesh";
    }
    this.regionTestFields.hidden = selectedMode !== "test";
  }

  setActiveStage(stage) {
    const activeStage = Number(stage) || 4;
    for (const radio of this.stageRadios) {
      radio.checked = Number(radio.value) === activeStage;
    }
    for (const panel of this.stagePanels) {
      panel.hidden =
        Number(panel.getAttribute("data-region-stage-panel")) !== activeStage;
    }
    this.sharedMapDisplayControls.hidden = activeStage === 5;
    this.onStageChange?.(activeStage);
  }

  setCalculatePlanDisabled(disabled) {
    this.byId("calculatePlanBtn").disabled = Boolean(disabled);
  }

  setStage5Planning(planning) {
    const active = Boolean(planning);
    this.byId("calculatePlanBtn").disabled = active;
    this.byId("savePlansBtn").disabled = active;
    this.byId("cancelPlanBtn").hidden = !active;
    this.byId("stage5ProgressWrap").hidden = !active;
    this.byId("stage5ConfigFields").disabled = active;
  }

  setStage5Progress({ phase, processed = 0, total = 0, ratio = 0 } = {}) {
    const phaseRanges = {
      target_geometry: [0, 0.1],
      worker_candidates: [0.1, 0.25],
      initial_raycast: [0.25, 0.65],
      local_replenishment: [0.65, 0.95],
      coverage_summary: [0.95, 1],
    };
    const localRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
    const [start, end] = phaseRanges[phase] || [0, 1];
    const value = start + (end - start) * localRatio;
    const labels = {
      target_geometry: "Preparing region geometry",
      worker_candidates: "Generating candidates",
      initial_raycast: "Checking initial cameras",
      local_replenishment: "Replenishing uncovered areas",
      coverage_summary: "Summarizing coverage",
    };
    this.byId("stage5ProgressText").textContent =
      `${labels[phase] || "Calculating"} ${processed}/${total}`;
    this.byId("stage5ProgressPct").textContent = `${Math.round(value * 100)}%`;
    this.byId("stage5ProgressFill").style.width = `${value * 100}%`;
  }

  readStage5Config() {
    return this.panelRenderer.readStage5Config();
  }

  resetStage5Config() {
    this.panelRenderer.setStage5Config();
  }

  setCollisionOpacity(opacity) {
    const value = Math.max(0, Math.min(1, Number(opacity) || 0));
    this.collisionOpacity.value = String(value);
    this.collisionOpacityValue.textContent = value.toFixed(2);
  }

  setNavmeshOpacity(opacity) {
    const value = Math.max(0, Math.min(1, Number(opacity) || 0));
    this.navmeshOpacity.value = String(value);
    this.navmeshOpacityValue.textContent = value.toFixed(2);
  }

  renderActiveRegions(regions) {
    this.panelRenderer.renderActiveRegions(regions);
  }

  setTestStatus(status) {
    this.panelRenderer.renderTestStatus(status);
  }

  readEditor() {
    return this.panelRenderer.readEditor();
  }

  render(options) {
    this.panelRenderer.render(options);
  }

  async confirm(message) {
    return this.confirmDialog.confirm(message);
  }

  dispose() {
    for (const { element, type, listener } of this.listeners) {
      element.removeEventListener(type, listener);
    }
    this.listeners = [];
  }

  addListener(element, type, listener) {
    if (!element || !listener) {
      return;
    }

    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }
}
