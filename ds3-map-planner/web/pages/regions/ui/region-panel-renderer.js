export class RegionPanelRenderer {
  constructor({ document, byId }) {
    this.document = document;
    this.byId = byId;
  }

  readPreviewPosition() {
    return [
      Number(this.byId("px").value),
      Number(this.byId("py").value),
      Number(this.byId("pz").value),
    ];
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

  render({ regions, selectedIndex, selectionMode, plans, onSelect }) {
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
      ...regions.map((region, index) =>
        this.createRegionListItem(region, index, selectedIndex, onSelect),
      ),
    );
    this.renderPlanInfo(plans, selected);
  }

  createRegionListItem(region, index, selectedIndex, onSelect) {
    const item = this.document.createElement("div");
    item.className = `region ${index === selectedIndex ? "selected" : ""}`;
    item.textContent = `${region.name} [${formatY(region.ymin)}, ${formatY(region.ymax)}]`;
    item.addEventListener("click", () => onSelect(index));
    return item;
  }

  renderPlanInfo(plans, selectedRegion) {
    const plan = plans.find(
      (item) => item.region_name === selectedRegion?.name,
    );
    this.byId("planInfo").textContent = plan
      ? JSON.stringify(plan, null, 2)
      : "No regional camera plan.";
  }
}

function roundY(value) {
  return Math.round(value * 100) / 100;
}

function formatY(value) {
  return roundY(Number(value) || 0).toFixed(2);
}
