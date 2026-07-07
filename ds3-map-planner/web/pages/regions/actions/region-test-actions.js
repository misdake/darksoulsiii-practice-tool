import { findRegionGroupOverlaps } from "../geometry/region-geometry.js";

export class RegionTestActions {
  constructor({
    missingPoints,
    getRegions,
    getRegionGroups,
    setStatus,
    applyEditorFields,
    focusGamePoint,
    toggleTestCameraMode,
  }) {
    this.missingPoints = missingPoints;
    this.getRegions = getRegions;
    this.getRegionGroups = getRegionGroups;
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
      onCheckOverlaps: () => this.checkOverlaps(),
    };
  }

  checkOverlaps() {
    const overlaps = findRegionGroupOverlaps(this.getRegionGroups());
    if (!overlaps.length) {
      this.setStatus("Overlap check: no cross-group prism overlaps found.");
      return;
    }
    const lines = overlaps.map(({ leftGroup, leftPrismIndex, rightGroup, rightPrismIndex, yOverlap }) =>
      `${formatGroup(leftGroup)} Prism ${leftPrismIndex + 1} <-> ` +
      `${formatGroup(rightGroup)} Prism ${rightPrismIndex + 1}; Y overlap ${yOverlap.toFixed(2)}`,
    );
    this.setStatus(`Overlap check: ${overlaps.length} cross-group pair(s).\n${lines.join("\n")}`, true);
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

function formatGroup(group) {
  return `${group.name} (${group.uuid.slice(0, 8)})`;
}
