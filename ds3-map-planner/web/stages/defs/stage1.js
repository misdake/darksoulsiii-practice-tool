export function createStage1Definition() {
  return {
    name: "Collision Filter",
    enter(ctx) {
      ctx.systems.collision.setStage({ visible: true, opacity: 0.9, selectable: true });
      ctx.systems.nav.setStage({
        visible: false,
        useMerged: true,
        hideDeleted: false,
        allowSegmentHighlight: false,
        allowNavObjHighlight: false,
      });
      ctx.ui.setSegmentToolsEnabled(false);
    },
    handleHideSelected(ctx) {
      ctx.actions.hideSelectedObject();
    },
    onKeyDown(ctx, event) {
      if (event.code !== "Delete") return false;
      ctx.actions.hideSelectedObject();
      return true;
    },
    resolvePick: (_hit, node) => (node.userData.kind === "collision" ? node : null),
    resolveNavMenuSelection: (_navObj) => null,
  };
}
