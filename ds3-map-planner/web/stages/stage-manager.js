export class StageManager {
  constructor(definitions, defaultStageId) {
    this.definitions = definitions || {};
    this.defaultStageId = Number(defaultStageId);
    this.currentStageId = this.normalize(defaultStageId);
  }

  normalize(stageId) {
    const n = Number(stageId);
    if (this.definitions[n]) return n;
    return this.defaultStageId;
  }

  getCurrentId() {
    return this.currentStageId;
  }

  getCurrent() {
    return this.definitions[this.currentStageId] || this.definitions[this.defaultStageId];
  }

  get(stageId) {
    return this.definitions[this.normalize(stageId)] || this.definitions[this.defaultStageId];
  }

  switchTo(stageId, ctx) {
    const nextId = this.normalize(stageId);
    const prevId = this.currentStageId;
    if (prevId === nextId) return nextId;
    const prev = this.get(prevId);
    if (prev?.exit) prev.exit(ctx);
    this.currentStageId = nextId;
    const next = this.get(nextId);
    if (next?.enter) next.enter(ctx);
    return nextId;
  }

  update(ctx, dt) {
    const cur = this.getCurrent();
    if (cur?.update) cur.update(ctx, dt);
  }
}
