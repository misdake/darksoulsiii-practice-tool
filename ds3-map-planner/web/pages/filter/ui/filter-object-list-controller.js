import { FilterHitFilterListController } from "./filter-hit-filter-list-controller.js";
import { createObjectRow } from "./filter-object-list-rows.js";

export class FilterObjectListController {
  constructor({
    document,
    collisionListEl,
    navmeshListEl,
    hitFilterListEl,
    displayName,
    getHitFilterTypeLabel,
    getStageConfig,
    onCollisionVisibilityChanged,
    onNavVisibilityChanged,
    onCollisionVisualsChanged,
    onSelectTarget,
  }) {
    this.document = document;
    this.collisionListEl = collisionListEl;
    this.navmeshListEl = navmeshListEl;
    this.displayName = displayName;
    this.getStageConfig = getStageConfig;
    this.onCollisionVisibilityChanged = onCollisionVisibilityChanged;
    this.onNavVisibilityChanged = onNavVisibilityChanged;
    this.onSelectTarget = onSelectTarget;
    this.rowByKey = new Map();
    this.hitFilterList = new FilterHitFilterListController({
      document,
      hitFilterListEl,
      getHitFilterTypeLabel,
      onCollisionVisibilityChanged,
      onCollisionVisualsChanged,
      onObjectMenuRefresh: () =>
        this.rebuildObjectMenu(this.lastCollisionGroup, this.lastNavmeshGroup),
    });
  }

  highlightSelectedTarget(target) {
    for (const row of this.rowByKey.values()) {
      row.classList.remove("obj-item-selected");
    }
    if (!target) {
      return;
    }

    const row = this.rowByKey.get(target.userData.rowKey);
    if (!row) {
      return;
    }

    row.classList.add("obj-item-selected");
    row.scrollIntoView({ block: "nearest" });
  }

  rebuildHitFilterMenu(collisionGroup) {
    this.hitFilterList.rebuild(collisionGroup);
  }

  rebuildObjectMenu(collisionGroup, navmeshGroup) {
    this.lastCollisionGroup = collisionGroup;
    this.lastNavmeshGroup = navmeshGroup;
    this.rowByKey.clear();

    this.collisionListEl.replaceChildren(
      ...this.createCollisionRows(collisionGroup),
    );
    this.navmeshListEl.replaceChildren(...this.createNavmeshRows(navmeshGroup));
  }

  createCollisionRows(collisionGroup) {
    if (!collisionGroup) {
      return [];
    }

    return collisionGroup.children.map((child) => {
      const hf = Number(child.userData?.meta?.msbHitFilterId ?? 255);
      return this.createObjectRow({
        key: `collision::${child.name}`,
        checked: child.userData.manualEnabled !== false,
        text: `${this.displayName(child.name)} [hf:${hf}]`,
        onToggle: (checked) => {
          child.userData.manualEnabled = checked;
          this.onCollisionVisibilityChanged();
          this.rebuildHitFilterMenu(this.lastCollisionGroup);
        },
        onSelect: () => this.onSelectTarget(child),
        targetObj: child,
      });
    });
  }

  createNavmeshRows(navmeshGroup) {
    if (!navmeshGroup) {
      return [];
    }

    return navmeshGroup.children.map((child) =>
      this.createObjectRow({
        key: `nav::${child.name}`,
        checked: child.userData.manualEnabled !== false,
        text: `${this.displayName(child.name)} [split:${
          child.userData.segmentCount || 0
        }]`,
        onToggle: (checked) => {
          child.userData.manualEnabled = checked;
          this.onNavVisibilityChanged();
        },
        onSelect: () => {
          const stageConfig = this.getStageConfig();
          this.onSelectTarget(stageConfig.resolveNavMenuSelection(child));
        },
        targetObj: child,
      }),
    );
  }

  createObjectRow(options) {
    return createObjectRow({
      document: this.document,
      ...options,
      registerRow: (key, row) => this.rowByKey.set(key, row),
    });
  }
}
