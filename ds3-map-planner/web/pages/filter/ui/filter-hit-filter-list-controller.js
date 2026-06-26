import {
  eyeSvgForState,
  eyeTitleForState,
  visibleStateFor,
} from "./filter-visibility-state.js";
import { createHitFilterRow } from "./filter-object-list-rows.js";

export class FilterHitFilterListController {
  constructor({
    document,
    hitFilterListEl,
    getHitFilterTypeLabel,
    onCollisionVisibilityChanged,
    onCollisionVisualsChanged,
    onObjectMenuRefresh,
  }) {
    this.document = document;
    this.hitFilterListEl = hitFilterListEl;
    this.getHitFilterTypeLabel = getHitFilterTypeLabel;
    this.onCollisionVisibilityChanged = onCollisionVisibilityChanged;
    this.onCollisionVisualsChanged = onCollisionVisualsChanged;
    this.onObjectMenuRefresh = onObjectMenuRefresh;
    this.lastCollisionGroup = null;
  }

  rebuild(collisionGroup) {
    this.lastCollisionGroup = collisionGroup;
    if (!this.hitFilterListEl) {
      return;
    }
    if (!collisionGroup || collisionGroup.children.length === 0) {
      this.hitFilterListEl.replaceChildren();
      return;
    }

    const rows = Array.from(hitFilterGroups(collisionGroup).entries())
      .sort((a, b) => a[0] - b[0])
      .map(([hf, objects]) => this.createRow(hf, objects));
    this.hitFilterListEl.replaceChildren(...rows);
  }

  createRow(hf, objects) {
    const { total, visibleCount, state } = visibleStateFor(objects);
    return createHitFilterRow({
      document: this.document,
      text: `hf:${hf} ${this.getHitFilterTypeLabel(hf, objects[0])} (${total})`,
      buttonTitle: eyeTitleForState(state),
      buttonHtml: eyeSvgForState(state),
      onToggle: () => this.toggleGroup(objects, visibleCount, total),
    });
  }

  toggleGroup(objects, visibleCount, total) {
    const nextVisible = visibleCount !== total;
    for (const obj of objects) {
      obj.userData.manualEnabled = nextVisible;
    }
    this.onCollisionVisibilityChanged();
    this.onObjectMenuRefresh();
    this.rebuild(this.lastCollisionGroup);
    this.onCollisionVisualsChanged();
  }
}

function hitFilterGroups(collisionGroup) {
  const groups = new Map();
  for (const child of collisionGroup.children) {
    const hf = Number(child.userData?.meta?.msbHitFilterId ?? 255);
    const key = Number.isFinite(hf) ? hf : 255;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(child);
  }
  return groups;
}
