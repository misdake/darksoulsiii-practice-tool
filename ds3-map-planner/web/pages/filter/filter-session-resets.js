export function resetVisibleStatesInMemory({
  visualController,
  currentDefaultHitFilterIds,
  clearSelection,
  rebuildObjectMenus,
  setStatus,
}) {
  visualController.applyDefaultVisibilityRules(currentDefaultHitFilterIds);
  clearSelection();
  visualController.applyCollisionVisibility();
  visualController.applyNavVisuals();
  rebuildObjectMenus();
  setStatus(
    "visible states reset in memory; click Save Filter to persist",
    false,
    2200,
  );
}

export function resetNavSegmentStatesInMemory({
  navSegmentUsageStates,
  clearSelection,
  visualController,
  setStatus,
}) {
  navSegmentUsageStates.clear();
  clearSelection();
  visualController.applyNavVisuals();
  setStatus(
    "nav segment states reset in memory; click Save Filter to persist",
    false,
    2200,
  );
}
