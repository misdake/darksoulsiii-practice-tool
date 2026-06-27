import { fetchJson } from "./shared/map-api.js";

const STAGES = [
  { key: "stage1-collision-filter", page: "filters.html", number: 1 },
  { key: "stage2-nav-filter", page: "filters.html", number: 2 },
  { key: "stage3-mark-nav", page: "filters.html", number: 3 },
  { key: "stage4-map-regions", page: "regions.html", number: 4 },
  { key: "stage6-map-region-shot-plans", page: "regions.html", number: 6 },
];

const rows = document.getElementById("mapRows");
const summary = document.getElementById("summary");
const status = document.getElementById("status");

loadDashboard();

async function loadDashboard() {
  try {
    const data = await fetchJson("/api/maps");
    const maps = Array.isArray(data.maps) ? data.maps : [];
    rows.replaceChildren(...maps.map(createMapRow));
    const started = maps.filter((map) =>
      Object.values(map.stage_status || {}).some(Boolean),
    ).length;
    summary.textContent = `${maps.length} maps, ${started} started`;
    status.textContent = maps.length ? "" : "No maps available.";
  } catch (error) {
    summary.textContent = "Unavailable";
    status.textContent = `Failed to load map progress: ${error.message}`;
    status.classList.add("error");
  }
}

function createMapRow(map) {
  const row = document.createElement("tr");
  row.append(createMapCell(map));
  for (const stage of STAGES) {
    row.append(
      createStateCell(Boolean(map.stage_status?.[stage.key]), stage, map.map_id),
    );
  }
  return row;
}

function createMapCell(map) {
  const cell = document.createElement("td");
  const name = document.createElement("div");
  name.className = "map-name";
  name.textContent = map.display_name || map.map_id;
  const id = document.createElement("div");
  id.className = "map-id";
  id.textContent = map.map_id;
  cell.append(name, id);
  return cell;
}

function createStateCell(saved, stage, mapId) {
  const cell = document.createElement("td");
  const state = document.createElement("a");
  state.className = saved ? "state saved" : "state";
  const query = new URLSearchParams({ map: mapId, stage: stage.number });
  state.href = `./${stage.page}?${query}`;
  state.textContent = saved ? "Saved" : "Pending";
  cell.append(state);
  return cell;
}
