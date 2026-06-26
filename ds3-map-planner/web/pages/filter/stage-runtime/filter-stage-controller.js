import { stageSaveData } from "./filter-stage-data.js";
import {
  createFilterStageContext,
  refreshFilterStageContext,
} from "./filter-stage-context.js";
import { syncFilterStageAfterApply } from "./filter-stage-sync.js";
import { FilterStageUiAdapter } from "./filter-stage-ui-adapter.js";

export class FilterStageController {
  constructor({
    stageManager,
    defaultStage,
    stageRadioEls,
    stageObjectListsEl,
    stage12ControlsEl,
    stage3ControlsEl,
    cameraModeBtn,
    stage3HideCollisionEl,
    stage3CollisionOpacityEl,
    stage3CollisionOpacityValueEl,
    staticContext,
    getCollisionGroup,
    getNavmeshGroup,
    getSelectedTarget,
    navSegmentUsageStates,
    systems,
    callbacks,
  }) {
    this.stageManager = stageManager;
    this.currentStage = stageManager.normalize(defaultStage);
    this.hasAppliedInitialStage = false;
    this.stageUi = new FilterStageUiAdapter({
      stageRadioEls,
      stageObjectListsEl,
      stage12ControlsEl,
      stage3ControlsEl,
      cameraModeBtn,
      stage3HideCollisionEl,
      stage3CollisionOpacityEl,
      stage3CollisionOpacityValueEl,
    });
    this.staticContext = staticContext;
    this.getCollisionGroup = getCollisionGroup;
    this.getNavmeshGroup = getNavmeshGroup;
    this.getSelectedTarget = getSelectedTarget;
    this.navSegmentUsageStates = navSegmentUsageStates;
    this.systems = systems;
    this.callbacks = callbacks;
    this.contextObject = this.createContextObject();
  }

  getStageConfig(stage = this.currentStage) {
    return this.stageManager.get(stage);
  }

  normalizeStage(stage) {
    return this.stageManager.normalize(stage);
  }

  buildContext() {
    return refreshFilterStageContext({
      contextObject: this.contextObject,
      currentStage: this.currentStage,
      getCollisionGroup: this.getCollisionGroup,
      getNavmeshGroup: this.getNavmeshGroup,
      getSelectedTarget: this.getSelectedTarget,
    });
  }

  applyStage(stage) {
    const previousStage = this.currentStage;
    const normalizedStage = this.stageManager.switchTo(
      stage,
      this.buildContext(),
    );
    if (!this.hasAppliedInitialStage && normalizedStage === previousStage) {
      this.stageManager.get(normalizedStage)?.enter?.(this.buildContext());
    }

    this.hasAppliedInitialStage = true;
    this.currentStage = normalizedStage;
    syncFilterStageAfterApply({
      normalizedStage,
      stageName: this.getStageConfig().name,
      stageUi: this.stageUi,
      systems: this.systems,
      callbacks: this.callbacks,
    });
  }

  update(dt) {
    this.stageManager.update(this.buildContext(), dt);
  }

  notifySceneReloaded() {
    this.getStageConfig().onSceneReload?.(this.buildContext());
  }

  createSaveData() {
    return stageSaveData(
      this.currentStage,
      this.getCollisionGroup(),
      this.getNavmeshGroup(),
      this.navSegmentUsageStates,
    );
  }

  createContextObject() {
    return createFilterStageContext({
      staticContext: this.staticContext,
      currentStage: this.currentStage,
      getCollisionGroup: this.getCollisionGroup,
      getNavmeshGroup: this.getNavmeshGroup,
      getSelectedTarget: this.getSelectedTarget,
      navSegmentUsageStates: this.navSegmentUsageStates,
      systems: this.systems,
      callbacks: this.callbacks,
      stageUi: this.stageUi,
    });
  }
}
