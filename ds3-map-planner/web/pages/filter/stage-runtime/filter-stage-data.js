export function collectEnabledPaths(group) {
  return (group?.children || [])
    .filter((child) => child.userData.manualEnabled !== false)
    .map((child) => child.name);
}

export function collectSelectedNavSegments(usageStates) {
  const selected = [];
  for (const [key, used] of usageStates) {
    if (!used) continue;
    const separator = key.lastIndexOf("::");
    if (separator <= 0) continue;
    selected.push({
      nav_name: key.slice(0, separator),
      segment_index: Number(key.slice(separator + 2)),
    });
  }
  return selected;
}

export function applySelectedNavSegments(data, usageStates, makeKey) {
  usageStates.clear();
  for (const item of data?.selected_nav_segments || []) {
    if (typeof item?.nav_name !== "string") continue;
    usageStates.set(
      makeKey(item.nav_name, Number(item.segment_index || 0)),
      true,
    );
  }
}

export function stageSaveData(
  stage,
  collisionGroup,
  navmeshGroup,
  usageStates,
) {
  if (stage === 1) {
    return { collision_enabled_paths: collectEnabledPaths(collisionGroup) };
  }
  if (stage === 2) {
    return { nav_enabled_paths: collectEnabledPaths(navmeshGroup) };
  }
  if (stage === 3) {
    return { selected_nav_segments: collectSelectedNavSegments(usageStates) };
  }
  return null;
}
