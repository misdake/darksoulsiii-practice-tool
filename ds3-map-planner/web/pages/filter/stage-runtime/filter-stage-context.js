export function createFilterStageContext({
  staticContext,
  currentStage,
  getCollisionGroup,
  getNavmeshGroup,
  getSelectedTarget,
  navSegmentUsageStates,
  systems,
  callbacks,
  stageUi,
}) {
  return {
    ...staticContext,
    currentStage,
    collisionGroup: getCollisionGroup(),
    navmeshGroup: getNavmeshGroup(),
    selectedTarget: getSelectedTarget(),
    navSegmentUsageStates,
    requestNavVisualRefresh: callbacks.applyNavVisuals,
    requestCollisionVisibilityRefresh: callbacks.applyCollisionVisibility,
    setStatus: callbacks.setStatus,
    systems,
    ui: stageUi.createStageContextUi(),
    actions: {
      hideSelectedObject: callbacks.hideSelectedObject,
    },
  };
}

export function refreshFilterStageContext({
  contextObject,
  currentStage,
  getCollisionGroup,
  getNavmeshGroup,
  getSelectedTarget,
}) {
  contextObject.currentStage = currentStage;
  contextObject.collisionGroup = getCollisionGroup();
  contextObject.navmeshGroup = getNavmeshGroup();
  contextObject.selectedTarget = getSelectedTarget();
  return contextObject;
}
