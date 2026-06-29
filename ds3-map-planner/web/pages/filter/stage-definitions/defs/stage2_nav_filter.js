export function createStage2NavFilterDefinition() {
  return {
    name: "Stage 2 Nav Filter",
    storageKey: "stage2-nav-filter",
    enter(ctx) {
      ctx.systems.collision.setStage({
        visible: false,
        opacity: 0.5,
        selectable: false,
      });
      ctx.systems.nav.setStage({
        visible: true,
        useMerged: false,
        hideDeleted: false,
        allowSegmentHighlight: false,
        allowNavObjHighlight: true,
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
      node.userData.kind === "navmesh" ? node : null,
    resolveNavMenuSelection: (navObj) => navObj,
  };
}
