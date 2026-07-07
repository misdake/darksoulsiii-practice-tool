import { flattenPrisms } from "../state/region-state.js";
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
      ? [...new Map(regions.map((region) => [region.groupUuid || region.name, region])).values()]
          .map((region) => region.name)
          .join(" -> ")
      : "No active regions.";
  }

  renderTestStatus({
    activeRegions = [],
    missingCount = 0,
    mode = "free",
    paused = true,
    playerReady = false,
    playerPosition = [0, 0, 0],
    warning = false,
  } = {}) {
    this.renderActiveRegions(activeRegions);
    const modeButton = this.byId("testModeBtn");
    if (modeButton) {
      modeButton.textContent =
        mode === "thirdPerson"
          ? "Switch To Free Camera (F)"
          : "Enter Third-Person (F)";
    }
    const playerStatus = this.byId("testPlayerStatus");
    if (playerStatus) {
      playerStatus.textContent = playerReady
        ? `Player: ${playerPosition.map((value) => value.toFixed(2)).join(", ")}`
        : "Player: click collision in the right viewport.";
    }
    const warningEl = this.byId("testWarning");
    if (warningEl) {
      warningEl.textContent = warning
        ? "Warning: player is outside every region."
        : paused
          ? "Paused: missing markers are not recorded."
          : "No runtime warning.";
      warningEl.style.color = warning ? "#fb7185" : "";
    }
    const missingEl = this.byId("testMissingCount");
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

  readStage5Config() {
    return normalizeRegionShotConfig({
      render_width: this.byId("stage5RenderWidth").value,
      render_height: this.byId("stage5RenderHeight").value,
      fov_y_rad: Number(this.byId("stage5FovDegrees").value) * Math.PI / 180,
      base_ratio_px_per_wu: this.byId("stage5BaseRatio").value,
      density_multiplier: this.byId("stage5DensityMultiplier").value,
      overlap_ratio: Number(this.byId("stage5OverlapPercent").value) / 100,
      y_lift: this.byId("stage5YLift").value,
    });
  }

  setStage5Config(config = DEFAULT_REGION_SHOT_CONFIG) {
    const value = normalizeRegionShotConfig(config);
    this.byId("stage5RenderWidth").value = String(value.render_width);
    this.byId("stage5RenderHeight").value = String(value.render_height);
    this.byId("stage5FovDegrees").value = (value.fov_y_rad * 180 / Math.PI).toFixed(2);
    this.byId("stage5BaseRatio").value = String(value.base_ratio_px_per_wu);
    this.byId("stage5DensityMultiplier").value = String(value.density_multiplier);
    this.byId("stage5OverlapPercent").value = String(value.overlap_ratio * 100);
    this.byId("stage5YLift").value = String(value.y_lift);
  }

  render({
    regionGroups = [],
    selectedPrisms = [],
    primaryPrism = null,
    mode,
    plans,
    planningTargetKey = "fallback",
    onSelect,
    onSelectGroup,
  }) {
    const descriptors = flattenPrisms(regionGroups);
    const selectedDescriptor = descriptors.find(({ prism }) => prism === primaryPrism) || null;
    this.byId("name").value = selectedDescriptor?.group.name || "";
    this.byId("ymin").value = formatY(primaryPrism?.ymin ?? 0);
    this.byId("ymax").value = formatY(primaryPrism?.ymax ?? 3);
    const selectionFields = this.byId("regionSelectionFields");
    if (selectionFields) {
      selectionFields.hidden = mode !== "regions" || !primaryPrism;
    }
    const deleteBtn = this.byId("deleteBtn");
    if (deleteBtn) {
      deleteBtn.disabled = !primaryPrism;
    }
    const splitHeightBtn = this.byId("splitRegionHeightBtn");
    if (splitHeightBtn) {
      splitHeightBtn.disabled = !primaryPrism;
    }
    this.byId("regions").replaceChildren(
      ...regionGroups.map((group) =>
        this.createRegionListGroup(
          group,
          descriptors,
          new Set(selectedPrisms),
          primaryPrism,
          onSelect,
          onSelectGroup,
        ),
      ),
    );
    this.renderStage5RegionOptions(regionGroups, planningTargetKey);
    this.renderPlanInfo(plans, regionGroups, planningTargetKey);
  }

  renderStage5RegionOptions(groups, planningTargetKey) {
    const select = this.byId("stage5RegionSelect");
    if (!select) return;
    select.replaceChildren(
      ...groups.map((group) => {
        const option = this.document.createElement("option");
        option.value = `region_group:${group.uuid}`;
        option.textContent = groupDisplayName(group, groups);
        option.selected = planningTargetKey === `region_group:${group.uuid}`;
        return option;
      }),
      createFallbackOption(this.document, planningTargetKey === "fallback"),
    );
    select.disabled = false;
  }

  createRegionListGroup(
    regionGroup,
    descriptors,
    selectedSet,
    primaryPrism,
    onSelect,
    onSelectGroup,
  ) {
    const group = this.document.createElement("div");
    group.className = `region-group ${regionGroup.prisms.some((prism) => selectedSet.has(prism)) ? "selected" : ""}`;
    const header = this.document.createElement("div");
    header.className = "region-group-header";
    header.textContent = regionGroup.name;
    header.addEventListener("click", () => onSelectGroup?.(regionGroup.uuid));
    group.replaceChildren(
      header,
      ...regionGroup.prisms.map((prism, prismIndex) =>
        this.createRegionListItem(
          prism,
          prismIndex,
          descriptors.findIndex((item) => item.prism === prism),
          primaryPrism,
          selectedSet,
          onSelect,
        ),
      ),
    );
    return group;
  }

  createRegionListItem(prism, prismIndex, index, primaryPrism, selectedSet, onSelect) {
    const item = this.document.createElement("div");
    item.className = `region ${selectedSet.has(index) ? "selected" : ""} ${
      prism === primaryPrism ? "primary" : ""
    }`;
    item.textContent = `Prism ${prismIndex + 1} [${formatY(prism.ymin)}, ${formatY(prism.ymax)}]`;
    item.addEventListener("click", (event) =>
      onSelect(index, { toggle: event.ctrlKey || event.metaKey }),
    );
    return item;
  }

  renderPlanInfo(plans, groups, planningTargetKey) {
    const selectedGroup = groups.find((group) => planningTargetKey === `region_group:${group.uuid}`);
    const plan = selectedGroup
      ? plans.find((item) => item.kind === "region_group" && item.region_group_uuid === selectedGroup.uuid && item.group_last_updated === selectedGroup.last_updated)
      : plans.find((item) => item.kind === "fallback");
    this.setStage5Config(plan?.config || DEFAULT_REGION_SHOT_CONFIG);
    this.byId("planInfo").textContent = plan
      ? formatPlanSummary(plan)
      : "No regional camera plan.";
  }
}

function formatPlanSummary(plan) {
  const coverage = plan.coverage || {};
  const rejected = coverage.rejected_by_reason || {};
  return [
    `Target: ${plan.kind === "fallback" ? "Fallback" : plan.region_group_name}`,
    `Cameras: ${formatMetric(coverage.final_count)}`,
    `Coverage: ${formatPercent(coverage.coverage_ratio)}`,
    `Area target / covered: ${formatArea(coverage.target_area)} / ${formatArea(coverage.covered_area)}`,
    `Area uncoverable / remaining: ${formatArea(coverage.uncoverable_area)} / ${formatArea(coverage.remaining_uncovered_area)}`,
    `Candidates / attempted: ${formatMetric(coverage.candidate_count)} / ${formatMetric(coverage.attempted_count)}`,
    `Lowered / replenished: ${formatMetric(coverage.lowered_count)} / ${formatMetric(coverage.replenished_count)}`,
    `Rejected: ${formatMetric(coverage.rejected_count)} (clearance ${formatMetric(rejected.clearance)}, occlusion ${formatMetric(rejected.occlusion)}, no coverage ${formatMetric(rejected.no_coverage)})`,
  ].join("\n");
}

function groupDisplayName(group, groups) {
  return groups.filter((candidate) => candidate.name === group.name).length > 1
    ? `${group.name} (${group.uuid.slice(0, 8)})`
    : group.name;
}

function createFallbackOption(document, selected) {
  const option = document.createElement("option");
  option.value = "fallback";
  option.textContent = "Fallback";
  option.selected = selected;
  return option;
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
