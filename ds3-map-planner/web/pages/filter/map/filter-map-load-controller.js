import {
  fetchJson,
  fetchOptionalJson,
  stageUrl,
} from "../../../shared/map-api.js";
import {
  collisionEntriesFromContent,
  navmeshEntriesFromContent,
  normalizeDefaultHitFilterIds,
} from "./filter-map-data.js";

export class FilterMapLoadController {
  constructor({ assetLoader, setProgress }) {
    this.assetLoader = assetLoader;
    this.setProgress = setProgress;
  }

  async loadMapList() {
    const data = await fetchJson("/api/maps");
    return data.maps || [];
  }

  async load(mapId) {
    this.setProgress(`loading ${mapId}`, 0);
    const {
      content,
      stage1: stage1Data,
      stage2: stage2Data,
      stage3: stage3Data,
    } = await loadFilterMapPrerequisites(mapId);

    const collisionEntries = collisionEntriesFromContent(content);
    const navmeshEntries = navmeshEntriesFromContent(content);
    const totalEntries = collisionEntries.length + navmeshEntries.length;
    if (totalEntries === 0) {
      this.setProgress(`loaded ${mapId}`, 1);
    }

    let loadedEntries = 0;
    const updateProgress = () => {
      if (totalEntries <= 0) {
        return;
      }
      loadedEntries += 1;
      this.setProgress(`loading ${mapId}`, loadedEntries / totalEntries);
    };

    const [collisionResult, navmeshResult] = await Promise.all([
      this.assetLoader.loadList(
        collisionEntries,
        this.assetLoader.loadCollision,
        updateProgress,
      ),
      this.assetLoader.loadList(
        navmeshEntries,
        this.assetLoader.loadNavmesh,
        updateProgress,
      ),
    ]);

    return {
      collisionGroup: collisionResult.group,
      navmeshGroup: navmeshResult.group,
      failedCount: collisionResult.failed.length + navmeshResult.failed.length,
      defaultHitFilterIds: normalizeDefaultHitFilterIds(content),
      stage1Data,
      stage2Data,
      stage3Data,
    };
  }
}

async function loadFilterMapPrerequisites(mapId) {
  const [content, stage1, stage2, stage3] = await Promise.all([
    fetchJson(stageUrl(mapId, "content")),
    fetchOptionalJson(stageUrl(mapId, "stage1-collision-filter")),
    fetchOptionalJson(stageUrl(mapId, "stage2-nav-filter")),
    fetchOptionalJson(stageUrl(mapId, "stage3-mark-nav")),
  ]);

  return { content, stage1, stage2, stage3 };
}
