export class FilterSelectionController {
  constructor({
    onVisualsChanged,
    onTargetVisibilityChanged = null,
    onTargetHidden = null,
  }) {
    this.selectedTarget = null;
    this.objectListController = null;
    this.onVisualsChanged = onVisualsChanged;
    this.onTargetVisibilityChanged = onTargetVisibilityChanged;
    this.onTargetHidden = onTargetHidden;
  }

  setObjectListController(objectListController) {
    this.objectListController = objectListController;
    this.highlightSelectedRow();
  }

  setSelectedTarget(target) {
    this.selectedTarget = target;
    this.highlightSelectedRow();
    this.onVisualsChanged();
  }

  clearSelection() {
    this.setSelectedTarget(null);
  }

  hideSelectedObject() {
    const target = this.selectedTarget;
    if (!this.isHideableTarget(target)) return;

    target.userData.manualEnabled = false;
    this.onTargetVisibilityChanged?.(target);
    this.clearSelection();
    this.onTargetHidden?.(target);
  }

  highlightSelectedRow() {
    this.objectListController?.highlightSelectedTarget(this.selectedTarget);
  }

  isHideableTarget(target) {
    return (
      target?.userData?.kind === "collision" ||
      target?.userData?.kind === "navmesh"
    );
  }
}
