export class FilterStageUiAdapter {
  constructor({
    stageRadioEls,
    stageObjectListsEl,
    stage12ControlsEl,
    stage3ControlsEl,
    cameraModeBtn,
    stage3HideCollisionEl,
    stage3CollisionOpacityEl,
    stage3CollisionOpacityValueEl,
  }) {
    this.stageRadioEls = stageRadioEls;
    this.stageObjectListsEl = stageObjectListsEl;
    this.stage12ControlsEl = stage12ControlsEl;
    this.stage3ControlsEl = stage3ControlsEl;
    this.cameraModeBtn = cameraModeBtn;
    this.stage3HideCollisionEl = stage3HideCollisionEl;
    this.stage3CollisionOpacityEl = stage3CollisionOpacityEl;
    this.stage3CollisionOpacityValueEl = stage3CollisionOpacityValueEl;
  }

  syncStage(stage) {
    for (const radio of this.stageRadioEls) {
      radio.checked = Number(radio.value) === stage;
    }
    if (this.stageObjectListsEl) {
      this.stageObjectListsEl.style.display = stage <= 2 ? "block" : "none";
    }
    if (this.stage12ControlsEl) {
      this.stage12ControlsEl.style.display = stage <= 2 ? "flex" : "none";
    }
    if (this.stage3ControlsEl) {
      this.stage3ControlsEl.style.display = stage === 3 ? "flex" : "none";
    }
  }

  createStageContextUi() {
    return {
      setSegmentToolsEnabled(_enabled) {},
      setCameraModeButton: ({ visible, text }) => {
        if (!this.cameraModeBtn) return;
        this.cameraModeBtn.style.display = visible ? "" : "none";
        if (typeof text === "string") this.cameraModeBtn.textContent = text;
      },
      setStage3CollisionHidden: (hidden) => {
        if (this.stage3HideCollisionEl) {
          this.stage3HideCollisionEl.checked = Boolean(hidden);
        }
      },
      setStage3CollisionOpacity: (opacity) => {
        const value = Math.max(0, Math.min(1, Number(opacity) || 0));
        if (this.stage3CollisionOpacityEl) {
          this.stage3CollisionOpacityEl.value = String(value);
        }
        if (this.stage3CollisionOpacityValueEl) {
          this.stage3CollisionOpacityValueEl.textContent = value.toFixed(2);
        }
      },
    };
  }
}
