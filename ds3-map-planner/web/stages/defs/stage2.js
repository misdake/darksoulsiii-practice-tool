export function createStage2Definition() {
  return {
    name: "Nav Object Filter",
    enter(ctx) {
      ctx.systems.collision.setStage({ visible: false, opacity: 0.5, selectable: false });
      ctx.systems.nav.setStage({
        visible: true,
        useMerged: true,
        hideDeleted: false,
        allowSegmentHighlight: false,
        allowNavObjHighlight: true,
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
    resolvePick: (_hit, node) => (node.userData.kind === "navmesh" ? node : null),
    resolveNavMenuSelection: (navObj) => navObj,
  };
}
