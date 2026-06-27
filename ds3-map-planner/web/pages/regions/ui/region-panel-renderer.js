import { displayRegionGroups } from "../state/region-state.js";
import {
  DEFAULT_REGION_SHOT_CONFIG,
  normalizeRegionShotConfig,
} from "../planning/region-shot-plan-system.js";

export class RegionPanelRenderer {
  constructor({ document, byId }) {
    this.document = document;
    this.byId = byId;
  }

  renderActiveRegions(regions) {
    const label = this.byId("active");
    if (!label) return;
    label.textContent = regions.length
      ? regions
          .map(
            (region) =>
              `${region.name} [${formatY(region.ymin)}, ${formatY(region.ymax)}]`,
          )
          .join(" -> ")
      : "No active regions.";
  }

  renderStage5Status({
    activeRegions = [],
    missingCount = 0,
    mode = "free",
    paused = true,
    playerReady = false,
    playerPosition = [0, 0, 0],
    warning = false,
  } = {}) {
    this.renderActiveRegions(activeRegions);
    const modeButton = this.byId("stage5ModeBtn");
    if (modeButton) {
      modeButton.textContent =
        mode === "thirdPerson"
          ? "Switch To Free Camera (F)"
          : "Enter Third-Person (F)";
    }
    const playerStatus = this.byId("stage5PlayerStatus");
    if (playerStatus) {
      playerStatus.textContent = playerReady
        ? `Player: ${playerPosition.map((value) => value.toFixed(2)).join(", ")}`
        : "Player: click collision in the right viewport.";
    }
    const warningEl = this.byId("stage5Warning");
    if (warningEl) {
      warningEl.textContent = warning
        ? "Warning: player is outside every region."
        : paused
          ? "Paused: missing markers are not recorded."
          : "No runtime warning.";
      warningEl.style.color = warning ? "#fb7185" : "";
    }
    const missingEl = this.byId("stage5MissingCount");
    if (missingEl) {
      missingEl.textContent = `Missing markers: ${missingCount}`;
    }
  }

  readEditor() {
    return {
      name: this.byId("name").value.trim(),
      ymin: roundY(Number(this.byId("ymin").value)),
      ymax: roundY(Number(this.byId("ymax").value)),
    };
  }

  readStage6Config() {
    return normalizeRegionShotConfig({
      render_width: this.byId("stage6RenderWidth").value,
      render_height: this.byId("stage6RenderHeight").value,
      fov_y_rad: Number(this.byId("stage6FovDegrees").value) * Math.PI / 180,
      base_ratio_px_per_wu: this.byId("stage6BaseRatio").value,
      density_multiplier: this.byId("stage6DensityMultiplier").value,
      overlap_ratio: Number(this.byId("stage6OverlapPercent").value) / 100,
      y_lift: this.byId("stage6YLift").value,
    });
  }

  setStage6Config(config = DEFAULT_REGION_SHOT_CONFIG) {
    const value = normalizeRegionShotConfig(config);
    this.byId("stage6RenderWidth").value = String(value.render_width);
    this.byId("stage6RenderHeight").value = String(value.render_height);
    this.byId("stage6FovDegrees").value = (value.fov_y_rad * 180 / Math.PI).toFixed(2);
    this.byId("stage6BaseRatio").value = String(value.base_ratio_px_per_wu);
    this.byId("stage6DensityMultiplier").value = String(value.density_multiplier);
    this.byId("stage6OverlapPercent").value = String(value.overlap_ratio * 100);
    this.byId("stage6YLift").value = String(value.y_lift);
  }

  render({
    regions,
    regionGroups = [],
    selectedIndex,
    selectedIndices = [],
    selectionMode,
    plans,
    onSelect,
  }) {
    const selected = regions[selectedIndex] || null;
    this.byId("name").value = selected?.name || "";
    this.byId("ymin").value = formatY(selected?.ymin ?? 0);
    this.byId("ymax").value = formatY(selected?.ymax ?? 3);
    const selectionFields = this.byId("regionSelectionFields");
    if (selectionFields) {
      selectionFields.hidden = selectionMode !== "region" || !selected;
    }
    const deleteBtn = this.byId("deleteBtn");
    if (deleteBtn) {
      deleteBtn.disabled = !selected;
    }
    this.byId("regions").replaceChildren(
      ...displayRegionGroups(regions, regionGroups).map((indices) =>
        this.createRegionListGroup(
          regions,
          indices,
          selectedIndex,
          selectedIndices,
          onSelect,
        ),
      ),
    );
    this.renderStage6RegionOptions(regions, selectedIndex);
    this.renderPlanInfo(plans, selected);
  }

  renderStage6RegionOptions(regions, selectedIndex) {
    const select = this.byId("stage6RegionSelect");
    if (!select) return;
    select.replaceChildren(
      ...regions.map((region, index) => {
        const option = this.document.createElement("option");
        option.value = String(index);
        option.textContent = region.name;
        option.selected = index === selectedIndex;
        return option;
      }),
    );
    select.disabled = regions.length === 0;
  }

  createRegionListGroup(
    regions,
    indices,
    selectedIndex,
    selectedIndices,
    onSelect,
  ) {
    const selectedSet = new Set(selectedIndices);
    const group = this.document.createElement("div");
    group.className = `region-group ${
      indices.some((index) => selectedSet.has(index)) ? "selected" : ""
    }`;
    group.replaceChildren(
      ...indices.map((index) =>
        this.createRegionListItem(
          regions[index],
          index,
          selectedIndex,
          selectedSet,
          onSelect,
        ),
      ),
    );
    return group;
  }

  createRegionListItem(region, index, selectedIndex, selectedSet, onSelect) {
    const item = this.document.createElement("div");
    item.className = `region ${selectedSet.has(index) ? "selected" : ""} ${
      index === selectedIndex ? "primary" : ""
    }`;
    item.textContent = `${region.name} [${formatY(region.ymin)}, ${formatY(region.ymax)}]`;
    item.addEventListener("click", (event) =>
      onSelect(index, { toggle: event.ctrlKey || event.metaKey }),
    );
    return item;
  }

  renderPlanInfo(plans, selectedRegion) {
    const plan = plans.find(
      (item) => item.region_name === selectedRegion?.name,
    );
    this.setStage6Config(plan?.config || DEFAULT_REGION_SHOT_CONFIG);
    this.byId("planInfo").textContent = plan
      ? formatPlanSummary(plan)
      : "No regional camera plan.";
  }
}

function formatPlanSummary(plan) {
  const coverage = plan.coverage || {};
  const rejected = coverage.rejected_by_reason || {};
  return [
    `Region: ${plan.region_name}`,
    `Cameras: ${formatMetric(coverage.final_count)}`,
    `Coverage: ${formatPercent(coverage.coverage_ratio)}`,
    `Area target / covered: ${formatArea(coverage.target_area)} / ${formatArea(coverage.covered_area)}`,
    `Area uncoverable / remaining: ${formatArea(coverage.uncoverable_area)} / ${formatArea(coverage.remaining_uncovered_area)}`,
    `Candidates / attempted: ${formatMetric(coverage.candidate_count)} / ${formatMetric(coverage.attempted_count)}`,
    `Lowered / replenished: ${formatMetric(coverage.lowered_count)} / ${formatMetric(coverage.replenished_count)}`,
    `Rejected: ${formatMetric(coverage.rejected_count)} (clearance ${formatMetric(rejected.clearance)}, occlusion ${formatMetric(rejected.occlusion)}, no coverage ${formatMetric(rejected.no_coverage)})`,
  ].join("\n");
}

function formatMetric(value) {
  return Number.isFinite(Number(value)) ? String(value) : "unavailable";
}

function formatArea(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "unavailable";
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "unavailable";
}

function roundY(value) {
  return Math.round(value * 100) / 100;
}

function formatY(value) {
  return roundY(Number(value) || 0).toFixed(2);
}
