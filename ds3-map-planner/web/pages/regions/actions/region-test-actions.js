export class RegionTestActions {
  constructor({
    missingPoints,
    getRegions,
    setStatus,
    applyEditorFields,
    focusGamePoint,
    toggleTestCameraMode,
  }) {
    this.missingPoints = missingPoints;
    this.getRegions = getRegions;
    this.setStatus = setStatus;
    this.applyEditorFields = applyEditorFields;
    this.focusGamePoint = focusGamePoint;
    this.toggleTestCameraMode = toggleTestCameraMode;
  }

  handlers() {
    return {
      onToggleTestCameraMode: () => this.toggleTestCameraMode(),
      onRecheckMissing: () => this.recheckMissing(),
      onFocusMissing: () => this.focusMissing(),
      onClearMissing: () => this.clearMissing(),
    };
  }

  recheckMissing() {
    if (!this.applyEditorFields()) return;
    const remaining = this.missingPoints.recheck(this.getRegions());
    this.setStatus(`Missing markers remaining: ${remaining}.`);
  }

  clearMissing() {
    this.missingPoints.clear();
    this.setStatus("Missing markers cleared.");
  }

  focusMissing() {
    const point = this.missingPoints.first();
    if (!point) {
      this.setStatus("No missing markers to focus.", true);
      return;
    }
    this.focusGamePoint(point);
    this.setStatus(`Focused missing marker at ${point.map((value) => value.toFixed(1)).join(", ")}.`);
  }
}
