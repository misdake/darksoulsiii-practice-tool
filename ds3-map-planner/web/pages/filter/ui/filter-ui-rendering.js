export function renderMapOptions({ document, mapSelect, maps = [] }) {
  if (!mapSelect) return;
  const options = [];

  for (const item of maps) {
    const mapId = typeof item === "string" ? item : item.map_id;
    const display =
      typeof item === "string" ? item : item.display_name || item.map_id;
    if (!mapId) continue;
    const option = document.createElement("option");
    option.value = mapId;
    option.textContent = `${mapId} - ${display}`;
    options.push(option);
  }

  mapSelect.replaceChildren(...options);
  if (!mapSelect.value && mapSelect.options.length > 0) {
    mapSelect.selectedIndex = 0;
  }
}

export function setLoadProgress({
  progressText,
  progressPercent,
  progressFill,
  progressWrap,
  text,
  ratio,
  visible = true,
}) {
  const value = Math.max(0, Math.min(1, Number(ratio) || 0));
  progressText.textContent = text;
  progressPercent.textContent = `${Math.round(value * 100)}%`;
  progressFill.style.width = `${value * 100}%`;
  progressWrap.style.display = visible ? "" : "none";
}

export function renderStageLabels(stageLabels, stageManager) {
  for (const [id, element] of stageLabels.entries()) {
    const config = stageManager.get(id);
    element.textContent = config?.name || `Stage ${id}`;
  }
}

export function setPanelCollapsed({ panel, collapseButton, collapsed }) {
  panel?.classList.toggle("panel-collapsed", Boolean(collapsed));
  if (!collapseButton) return;
  collapseButton.textContent = collapsed ? "+" : "-";
  collapseButton.title = collapsed ? "Expand panel" : "Collapse panel";
  collapseButton.setAttribute("aria-label", collapseButton.title);
  collapseButton.setAttribute("aria-expanded", String(!collapsed));
}
