export function syncFilterStageAfterApply({
  normalizedStage,
  stageName,
  stageUi,
  systems,
  callbacks,
}) {
  stageUi.syncStage(normalizedStage);
  callbacks.clearSelection();
  callbacks.applyCollisionVisibility();
  systems.collision.applyOpacity();
  systems.nav.applyVisibility(true);
  callbacks.applyCollisionVisuals();
  callbacks.applyNavVisuals();
  callbacks.setStatus(stageName || `Stage ${normalizedStage}`);
}
