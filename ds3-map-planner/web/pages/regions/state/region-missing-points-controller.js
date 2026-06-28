import { activeRegions } from "../geometry/region-geometry.js";

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

export function gapMarkerKey([x, y, z], cellSize = 0.5) {
  return [x, y, z].map((value) => Math.floor(value / cellSize)).join(":");
}

export function addGapMarker(markers, point, cellSize = 0.5) {
  const key = gapMarkerKey(point, cellSize);
  if (markers.has(key)) return false;
  markers.set(key, [...point]);
  return true;
}
