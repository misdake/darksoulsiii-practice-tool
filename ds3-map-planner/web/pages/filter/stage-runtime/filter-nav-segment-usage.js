import { navSegmentKey } from "./filter-stage-state.js";

export class FilterNavSegmentUsage {
  constructor() {
    this.states = new Map();
  }

  getState(path, segmentIndex) {
    return this.getUsage(path, segmentIndex) ? "selected" : "unset";
  }

  getUsage(path, segmentIndex) {
    return this.states.get(navSegmentKey(path, segmentIndex)) === true;
  }

  clear() {
    this.states.clear();
  }
}
