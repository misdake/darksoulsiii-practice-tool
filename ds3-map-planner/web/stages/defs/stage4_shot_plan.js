export function createStage4ShotPlanDefinition() {
  return {
    name: "Stage 4 Shot Plan",
    storageKey: "stage4-shot-plan",
    enter(ctx) {
      ctx.systems.collision.setStage({ visible: true, opacity: 0.7, selectable: false });
      ctx.systems.nav.setStage({ visible: true, useMerged: false, hideDeleted: false, allowSegmentHighlight: false, allowNavObjHighlight: false, selectedOnly: true });
      ctx.ui.setCameraModeButton({ visible: false });
      ctx.ui.setShotPlanPanelVisible(true);
      ctx.systems.shotPlan.enter(ctx);
    },
    exit(ctx) {
      ctx.systems.shotPlan.exit(ctx);
      ctx.ui.setShotPlanPanelVisible(false);
    },
    onSceneReload(ctx) {
      ctx.systems.shotPlan.onSceneReload(ctx);
    },
    onPointerClick(ctx, event) {
      return ctx.systems.shotPlan.onPointerClick(ctx, event);
    },
    onKeyDown(ctx, event) {
      return ctx.systems.shotPlan.onKeyDown(ctx, event);
    },
    onKeyUp(ctx, event) {
      return ctx.systems.shotPlan.onKeyUp(ctx, event);
    },
    update(ctx, dt) {
      ctx.systems.shotPlan.update(ctx, dt);
    },
    resolvePick: () => null,
    resolveNavMenuSelection: () => null,
  };
}
