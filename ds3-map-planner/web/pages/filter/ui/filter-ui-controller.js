import { collectFilterUiElements } from "./filter-ui-elements.js";
import {
  renderMapOptions,
  renderStageLabels,
  setLoadProgress,
  setPanelCollapsed,
} from "./filter-ui-rendering.js";

export class FilterUiController {
  constructor(document) {
    this.document = document;
    Object.assign(this, collectFilterUiElements(document));
    this.listeners = [];
  }

  bindActions({
    onPanelToggle,
    onStageChange,
    onMapChange,
    onFitCamera,
    onResetVisible,
    onResetNavSegments,
    onStage3CollisionHiddenChange,
    onStage3CollisionOpacityInput,
    onSave,
    onToggleCameraMode,
  }) {
    this.addListener(this.collapseButton, "click", onPanelToggle);
    for (const radio of this.stageRadios) {
      this.addListener(radio, "change", () => {
        if (radio.checked) onStageChange(Number(radio.value));
      });
    }
    this.addListener(this.mapSelect, "change", onMapChange);
    this.addListener(this.fitButton, "click", onFitCamera);
    this.addListener(this.resetVisibleButton, "click", onResetVisible);
    this.addListener(
      this.resetNavSegmentButton,
      "click",
      onResetNavSegments,
    );
    this.addListener(
      this.stage3HideCollision,
      "change",
      onStage3CollisionHiddenChange,
    );
    this.addListener(
      this.stage3CollisionOpacity,
      "input",
      onStage3CollisionOpacityInput,
    );
    this.addListener(this.saveButton, "click", onSave);
    this.addListener(this.cameraModeButton, "click", onToggleCameraMode);
  }

  get selectedMapId() {
    return this.mapSelect?.value || "";
  }

  setMapSelectDisabled(disabled) {
    if (this.mapSelect) this.mapSelect.disabled = Boolean(disabled);
  }

  renderMapOptions(maps = []) {
    renderMapOptions({
      document: this.document,
      mapSelect: this.mapSelect,
      maps,
    });
  }

  setProgress(text, ratio, visible = true) {
    setLoadProgress({
      progressText: this.progressText,
      progressPercent: this.progressPercent,
      progressFill: this.progressFill,
      progressWrap: this.progressWrap,
      text,
      ratio,
      visible,
    });
  }

  renderStageLabels(stageManager) {
    renderStageLabels(this.stageLabels, stageManager);
  }

  setPanelCollapsed(collapsed) {
    setPanelCollapsed({
      panel: this.panel,
      collapseButton: this.collapseButton,
      collapsed,
    });
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
