export function normalizeDefaultHitFilterIds(content) {
  return Array.isArray(content?.default_hit_filter_ids)
    ? content.default_hit_filter_ids
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    : [8];
}

export function collisionEntriesFromContent(content) {
  return (content?.collision_manifest?.instances || []).map((instance) => ({
    path: instance.OutObjFile,
    msbHitFilterId: Number.isFinite(instance.MsbHitFilterId)
      ? instance.MsbHitFilterId
      : 255,
    msbHitFilterType: instance.MsbHitFilterType || "Unknown",
  }));
}

export function navmeshEntriesFromContent(content) {
  return (content?.navmesh_manifest?.navmeshes || []).map((navmesh) => ({
    path: navmesh.path,
  }));
}