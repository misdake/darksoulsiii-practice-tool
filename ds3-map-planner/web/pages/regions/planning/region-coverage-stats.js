import { footprintForHeight } from "../geometry/region-coverage-geometry.js";

export function createCoverageStats({ targetCells, workerResult, adjustment }) {
  const coveredKeys = new Set(adjustment.covered_cell_keys || []);
  const uncoverableKeys = new Set(adjustment.uncoverable_cell_keys || []);
  const remainingKeys = new Set(adjustment.remaining_cell_keys || []);
  const targetArea = sumCellArea(targetCells);
  const coveredArea = sumCellArea(
    targetCells.filter((cell) => coveredKeys.has(cell.key)),
  );
  const uncoverableArea = sumCellArea(
    targetCells.filter((cell) => uncoverableKeys.has(cell.key)),
  );
  const remainingArea = sumCellArea(
    targetCells.filter((cell) => remainingKeys.has(cell.key)),
  );

  return {
    coverage_basis: "region_prism_weighted_grid_v2",
    target_area: targetArea,
    covered_area: coveredArea,
    uncoverable_area: uncoverableArea,
    remaining_uncovered_area: remainingArea,
    coverage_ratio: targetArea ? coveredArea / targetArea : 0,
    target_cells: targetCells.length,
    covered_cells: coveredKeys.size,
    candidate_count: workerResult.points.length,
    attempted_count: adjustment.attempted,
    lowered_count: adjustment.lowered,
    rejected_count: sumRejects(adjustment.rejected_by_reason),
    rejected_by_reason: { ...adjustment.rejected_by_reason },
    replenished_count: adjustment.replenished_count || 0,
    final_count: adjustment.points.length,
  };
}

export function cellIsInCameraFootprint(cell, camera, config) {
  if (Math.abs(cell.y_ref - camera.y_ref) > 0.75) return false;
  const height = Math.max(0, camera.y - camera.y_ref);
  const footprint = footprintForHeight(config, height);
  return (
    Math.abs(cell.x - camera.x) <= footprint.width / 2 &&
    Math.abs(cell.z - camera.z) <= footprint.height / 2
  );
}

function sumCellArea(cells) {
  return cells.reduce((sum, cell) => sum + (Number(cell.area) || 0), 0);
}

function sumRejects(reasons = {}) {
  return Object.values(reasons).reduce((sum, count) => sum + count, 0);
}
