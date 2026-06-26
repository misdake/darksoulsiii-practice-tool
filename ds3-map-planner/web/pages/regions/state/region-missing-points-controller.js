import {
  activeRegions,
  addGapMarker,
  findUncoveredSamples,
} from "../geometry/region-geometry.js";

export class RegionMissingPointsController {
  constructor({ renderPoints }) {
    this.pointsByCell = new Map();
    this.renderPoints = renderPoints;
  }

  get size() {
    return this.pointsByCell.size;
  }

  get points() {
    return [...this.pointsByCell.values()];
  }

  first() {
    return this.points[0] || null;
  }

  record(point) {
    if (!addGapMarker(this.pointsByCell, point)) return false;
    this.render();
    return true;
  }

  render(points = this.points) {
    this.renderPoints(points);
  }

  showUncoveredSamples(regions, triangles) {
    const points = findUncoveredSamples(regions, triangles);
    this.render(points);
    return points;
  }

  recheck(regions) {
    for (const [cell, point] of this.pointsByCell) {
      if (activeRegions(regions, point).length) this.pointsByCell.delete(cell);
    }
    this.render();
    return this.size;
  }

  clear() {
    this.pointsByCell.clear();
    this.render();
  }
}
