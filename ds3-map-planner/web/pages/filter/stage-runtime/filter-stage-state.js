export function navSegmentKey(navPath, segmentIndex) {
  return `${navPath}::${Number(segmentIndex)}`;
}

export function applyEnabledPaths(
  group,
  paths,
  displayName = (value) => value,
) {
  if (!group || !Array.isArray(paths)) {
    return false;
  }

  const exact = new Set(paths);
  const base = new Set(paths.map((path) => displayName(String(path || ""))));
  for (const child of group.children) {
    child.userData.manualEnabled =
      exact.has(child.name) || base.has(displayName(child.name));
  }

  return true;
}

export function selectedNavSegmentKeys(stage3Data) {
  const selected = Array.isArray(stage3Data?.selected_nav_segments)
    ? stage3Data.selected_nav_segments
    : [];

  return new Set(
    selected
      .filter((item) => typeof item?.nav_name === "string")
      .map((item) => navSegmentKey(item.nav_name, item.segment_index)),
  );
}
