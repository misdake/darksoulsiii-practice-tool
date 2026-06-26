export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-cache", ...options });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  return response.json();
}

export async function fetchOptionalJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-cache", ...options });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  return response.json();
}

export function stageUrl(mapId, stage) {
  return `/api/maps/${encodeURIComponent(mapId)}/${stage}`;
}

export async function loadOptionalStages(mapId, stageNames) {
  const values = await Promise.all(
    stageNames.map((stage) => fetchOptionalJson(stageUrl(mapId, stage))),
  );
  return Object.fromEntries(
    stageNames.map((stage, index) => [stage, values[index]]),
  );
}

export function saveStageData(mapId, stage, data) {
  return fetchJson(stageUrl(mapId, stage), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}
