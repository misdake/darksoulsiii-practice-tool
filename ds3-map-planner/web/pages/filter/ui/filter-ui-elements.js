import { createStatusReporter } from "../../../shared/status-reporter.js";

export function collectFilterUiElements(document) {
  const byId = (id) => document.getElementById(id);
  return {
    byId,
    panel: byId("panel"),
    collapseButton: byId("panelCollapseBtn"),
    mapSelect: byId("mapSelect"),
    cameraModeButton: byId("cameraModeBtn"),
    collisionList: byId("collisionList"),
    navmeshList: byId("navmeshList"),
    hitFilterList: byId("hitFilterList"),
    stageObjectLists: byId("stageObjectLists"),
    stage12Controls: byId("stage12Controls"),
    stage3Controls: byId("stage3Controls"),
    stage3HideCollision: byId("stage3HideCollision"),
    stage3CollisionOpacity: byId("stage3CollisionOpacity"),
    stage3CollisionOpacityValue: byId("stage3CollisionOpacityValue"),
    fitButton: byId("fitBtn"),
    resetVisibleButton: byId("resetVisibleBtn"),
    resetNavSegmentButton: byId("resetNavSegmentBtn"),
    saveButton: byId("saveBtn"),
    regionsPageButton: byId("regionsPageBtn"),
    stageRadios: Array.from(document.querySelectorAll('input[name="stage"]')),
    stageLabels: new Map(
      Array.from(document.querySelectorAll("[data-stage-label]")).map((el) => [
        Number(el.getAttribute("data-stage-label")),
        el,
      ]),
    ),
    status: createStatusReporter(byId("status"), {
      errorColor: "#ff9f9f",
    }),
    progressText: byId("loadProgressText"),
    progressPercent: byId("loadProgressPct"),
    progressFill: byId("loadProgressFill"),
    progressWrap: byId("loadProgressWrap"),
  };
}
