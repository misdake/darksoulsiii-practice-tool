import { saveStageData } from "../../../shared/map-api.js";
import { noStageDataStatus } from "../map/filter-map-session-status.js";

export async function saveCurrentFilterStage({
  currentMapId,
  stageController,
  setStatus,
}) {
  if (!currentMapId) return;

  const stage = stageController.getStageConfig();
  const data = stageController.createSaveData();
  if (!data) {
    setStatus(noStageDataStatus(stage), true);
    return;
  }

  try {
    await saveStageData(currentMapId, stage.storageKey, data);
    setStatus(
      `saved ${stage.storageKey}.json for ${currentMapId}`,
      false,
      2200,
    );
  } catch (e) {
    setStatus(`save failed: ${e.message || e}`, true);
  }
}
