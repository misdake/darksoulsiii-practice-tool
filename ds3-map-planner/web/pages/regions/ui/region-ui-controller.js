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
    this.stage4ShowCollision = this.byId("stage4ShowCollision");
    this.stage4CollisionOpacity = this.byId("stage4CollisionOpacity");
    this.stage4CollisionOpacityValue = this.byId("stage4CollisionOpacityValue");
    this.stage4NavmeshOpacity = this.byId("stage4NavmeshOpacity");
    this.stage4NavmeshOpacityValue = this.byId("stage4NavmeshOpacityValue");
    this.stage4SelectionModeRadios = Array.from(
      document.querySelectorAll('input[name="stage4SelectMode"]'),
    );
    this.regionFields = this.byId("regionFields");
    this.navmeshFields = this.byId("navmeshFields");
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
    onEdit,
    onDelete,
    onSave,
    onCalculatePlan,
    onSavePlans,
    onClear,
    onCalculateRegions,
    onEditorChange,
    onCheckCoverage,
    onPreviewPosition,
    onToggleStage5Mode,
    onRecheckMissing,
    onFocusMissing,
    onClearMissing,
    onBack,
    onFitCamera,
    onStageChange,
    onStage4SelectionModeChange,
    onStage4CollisionVisibleChange,
    onStage4CollisionOpacityInput,
    onStage4NavmeshOpacityInput,
  }) {
    this.onStageChange = onStageChange;
    for (const radio of this.stageRadios) {
      this.addListener(radio, "change", () => {
        if (radio.checked) this.setActiveStage(Number(radio.value));
      });
    }
    this.addListener(this.byId("newBtn"), "click", onNew);
    this.addListener(this.byId("deleteBtn"), "click", onDelete);
    this.addListener(this.byId("saveBtn"), "click", onSave);
    this.addListener(this.byId("calculatePlanBtn"), "click", onCalculatePlan);
    this.addListener(this.byId("savePlansBtn"), "click", onSavePlans);
    this.addListener(this.byId("clearBtn"), "click", onClear);
    this.addListener(
      this.byId("calculateRegionsBtn"),
      "click",
      onCalculateRegions,
    );
    this.addListener(
      this.byId("calculateRegionsBtnNav"),
      "click",
      onCalculateRegions,
    );
    for (const radio of this.stage4SelectionModeRadios) {
      this.addListener(radio, "change", () => {
        if (radio.checked) {
          this.setStage4SelectionMode(radio.value);
          onStage4SelectionModeChange?.(radio.value);
        }
      });
    }
    this.addListener(this.byId("checkBtn"), "click", onCheckCoverage);
    this.addListener(this.byId("previewBtn"), "click", onPreviewPosition);
    this.addListener(this.byId("stage5ModeBtn"), "click", onToggleStage5Mode);
    this.addListener(this.byId("recheckMissingBtn"), "click", onRecheckMissing);
    this.addListener(this.byId("focusMissingBtn"), "click", onFocusMissing);
    this.addListener(this.byId("clearMissingBtn"), "click", onClearMissing);
    this.addListener(this.byId("backBtn"), "click", onBack);
    this.addListener(this.byId("fitCameraBtn"), "click", onFitCamera);
    this.addListener(this.stage4ShowCollision, "change", () =>
      onStage4CollisionVisibleChange?.(this.stage4ShowCollision.checked),
    );
    this.addListener(this.stage4CollisionOpacity, "input", () => {
      const opacity = Number(this.stage4CollisionOpacity.value);
      this.setStage4CollisionOpacity(opacity);
      onStage4CollisionOpacityInput?.(opacity);
    });
    this.addListener(this.stage4NavmeshOpacity, "input", () => {
      const opacity = Number(this.stage4NavmeshOpacity.value);
      this.setStage4NavmeshOpacity(opacity);
      onStage4NavmeshOpacityInput?.(opacity);
    });
    for (const id of ["name", "ymin", "ymax"]) {
      this.addListener(this.byId(id), "change", onEditorChange);
    }
    this.setActiveStage(this.currentStage());
    this.setStage4SelectionMode(this.stage4SelectionMode());
    onStage4SelectionModeChange?.(this.stage4SelectionMode());
    onStage4CollisionVisibleChange?.(this.stage4ShowCollision?.checked ?? true);
    const initialOpacity = Number(this.stage4CollisionOpacity?.value);
    this.setStage4CollisionOpacity(initialOpacity);
    onStage4CollisionOpacityInput?.(initialOpacity);
    const initialNavmeshOpacity = Number(this.stage4NavmeshOpacity?.value);
    this.setStage4NavmeshOpacity(initialNavmeshOpacity);
    onStage4NavmeshOpacityInput?.(initialNavmeshOpacity);
  }

  currentStage() {
    const checked = this.stageRadios.find((radio) => radio.checked);
    return Number(checked?.value) || 4;
  }

  stage4SelectionMode() {
    const checked = this.stage4SelectionModeRadios.find(
      (radio) => radio.checked,
    );
    return checked?.value === "navmesh" ? "navmesh" : "region";
  }

  setStage4SelectionMode(mode) {
    const selectedMode = mode === "navmesh" ? "navmesh" : "region";
    for (const radio of this.stage4SelectionModeRadios) {
      radio.checked = radio.value === selectedMode;
    }
    if (this.regionFields) {
      this.regionFields.hidden = selectedMode !== "region";
    }
    if (this.navmeshFields) {
      this.navmeshFields.hidden = selectedMode !== "navmesh";
    }
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
    this.onStageChange?.(activeStage);
  }

  setCalculatePlanDisabled(disabled) {
    this.byId("calculatePlanBtn").disabled = Boolean(disabled);
  }

  setStage4CollisionOpacity(opacity) {
    const value = Math.max(0, Math.min(1, Number(opacity) || 0));
    if (this.stage4CollisionOpacity) {
      this.stage4CollisionOpacity.value = String(value);
    }
    if (this.stage4CollisionOpacityValue) {
      this.stage4CollisionOpacityValue.textContent = value.toFixed(2);
    }
  }

  setStage4NavmeshOpacity(opacity) {
    const value = Math.max(0, Math.min(1, Number(opacity) || 0));
    if (this.stage4NavmeshOpacity) {
      this.stage4NavmeshOpacity.value = String(value);
    }
    if (this.stage4NavmeshOpacityValue) {
      this.stage4NavmeshOpacityValue.textContent = value.toFixed(2);
    }
  }

  readPreviewPosition() {
    return this.panelRenderer.readPreviewPosition();
  }

  renderActiveRegions(regions) {
    this.panelRenderer.renderActiveRegions(regions);
  }

  setStage5Status(status) {
    this.panelRenderer.renderStage5Status(status);
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
