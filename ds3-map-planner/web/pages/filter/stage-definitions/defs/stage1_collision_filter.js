export function createStage1CollisionFilterDefinition() {
  return {
    name: "Stage 1 Collision Filter",
    storageKey: "stage1-collision-filter",
    enter(ctx) {
      ctx.systems.collision.setStage({
        visible: true,
        opacity: 0.9,
        selectable: true,
      });
      ctx.systems.nav.setStage({
        visible: false,
        useMerged: true,
        hideDeleted: false,
        allowSegmentHighlight: false,
        allowNavObjHighlight: false,
        selectedOnly: false,
      });
      ctx.ui.setSegmentToolsEnabled(false);
      ctx.ui.setCameraModeButton({ visible: false });
    },
    handleHideSelected(ctx) {
      ctx.actions.hideSelectedObject();
    },
    onKeyDown(ctx, event) {
      if (event.code !== "Delete") return false;
      ctx.actions.hideSelectedObject();
      return true;
    },
    resolvePick: (_hit, node) =>
      node.userData.kind === "collision" ? node : null,
    resolveNavMenuSelection: (_navObj) => null,
  };
}
