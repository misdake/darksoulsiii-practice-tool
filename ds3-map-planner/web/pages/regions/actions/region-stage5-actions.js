import {
  findCrossGroupRegionOverlaps,
  validateRegions,
} from "../geometry/region-geometry.js";
import {
  collectNavmeshTriangles,
} from "../assets/region-navmesh-utils.js";
import { summarizeUncoveredCoverage } from "../geometry/region-coverage-geometry.js";

export class RegionStage5Actions {
  constructor({
    navGroup,
    missingPoints,
    getRegions,
    getRegionGroups,
    setStatus,
    applyEditorFields,
    focusGamePoint,
    toggleStage5Mode,
    isOutdoorRegionEnabled,
  }) {
    this.navGroup = navGroup;
    this.missingPoints = missingPoints;
    this.getRegions = getRegions;
    this.getRegionGroups = getRegionGroups;
    this.setStatus = setStatus;
    this.applyEditorFields = applyEditorFields;
    this.focusGamePoint = focusGamePoint;
    this.toggleStage5Mode = toggleStage5Mode;
    this.isOutdoorRegionEnabled = isOutdoorRegionEnabled;
  }

  handlers() {
    return {
      onCheckCoverage: () => this.checkCoverage(),
      onToggleStage5Mode: () => this.toggleStage5Mode(),
      onRecheckMissing: () => this.recheckMissing(),
      onFocusMissing: () => this.focusMissing(),
      onClearMissing: () => this.clearMissing(),
    };
  }

  checkCoverage() {
    if (!this.applyEditorFields()) return;
    const regions = this.getRegions();
    const error = validateRegions(regions);
    if (error) {
      this.setStatus(error, true);
      return;
    }
    const overlaps = findCrossGroupRegionOverlaps(
      regions,
      this.getRegionGroups(),
    );
    if (overlaps.length) {
      this.setStatus(
        `Cross-group region overlap: ${overlaps
          .map(({ first, second }) => `${first.name} / ${second.name}`)
          .join(", ")}.`,
        true,
      );
      return;
    }

    const triangles = collectNavmeshTriangles(this.navGroup);
    const points = this.missingPoints.showUncoveredSamples(regions, triangles);
    const summary = summarizeUncoveredCoverage(points, triangles);
    const representative = summary.representative
      ? summary.representative.map((value) => value.toFixed(1)).join(", ")
      : "none";
    this.setStatus(
      [
        `Coverage check: ${summary.sampleCount} uncovered samples.`,
        `Uncovered area: ${summary.uncoveredArea.toFixed(1)} / ${summary.targetArea.toFixed(1)} (${(summary.uncoveredRatio * 100).toFixed(1)}%).`,
        `Largest gap: ${summary.largestComponentArea.toFixed(1)} near ${representative}.`,
      ].join("\n"),
      summary.sampleCount > 0,
    );
  }

  recheckMissing() {
    if (!this.applyEditorFields()) return;
    if (this.isOutdoorRegionEnabled?.()) {
      this.missingPoints.clear();
      this.setStatus("Missing markers remaining: 0.");
      return;
    }
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
