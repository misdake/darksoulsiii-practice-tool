import {
  footprintForHeight,
  triangleCoverageSamples,
} from "../geometry/region-coverage-geometry.js";

export function createCoverageStats({ triangles, workerResult, adjustment }) {
  const samples = collectCoverageSamples(triangles);
  const covered = samples.filter((sample) =>
    isSampleCovered(sample, adjustment.points, workerResult.config),
  ).length;
  const targetArea = triangles.reduce(
    (sum, triangle) => sum + triangleAreaXZ(...triangle),
    0,
  );
  const coveredRatio = samples.length ? covered / samples.length : 0;

  return {
    coverage_basis: "sample_area_estimate",
    target_area: targetArea,
    covered_area: targetArea * coveredRatio,
    uncoverable_area: targetArea * (1 - coveredRatio),
    coverage_samples: samples.length,
    covered_samples: covered,
    candidate_count: workerResult.points.length,
    lowered_count: adjustment.lowered,
    rejected_count: adjustment.rejected,
    replenished_count: adjustment.replenished_count || 0,
    final_count: adjustment.points.length,
  };
}

export function collectCoverageSamples(triangles) {
  return triangles.flatMap((triangle) => triangleCoverageSamples(...triangle));
}

export function isSampleCovered(sample, cameras, config) {
  return cameras.some((camera) => {
    const height = Math.max(0, camera.y - camera.y_ref);
    const footprint = footprintForHeight(config, height);
    return (
      Math.abs(sample[0] - camera.x) <= footprint.width / 2 &&
      Math.abs(sample[2] - camera.z) <= footprint.height / 2
    );
  });
}

export function cameraHeightFromConfig(config) {
  const density =
    Math.max(1e-6, config.base_ratio_px_per_wu) *
    Math.max(1e-6, config.density_multiplier);
  const coverageHeight = config.render_height / density;
  const halfFov = Math.max(
    1e-4,
    Math.min(Math.PI * 0.5 - 1e-4, config.fov_y_rad * 0.5),
  );
  return (coverageHeight * 0.5) / Math.max(1e-6, Math.tan(halfFov));
}

function triangleAreaXZ(a, b, c) {
  return (
    Math.abs(
      (b[0] - a[0]) * (c[2] - a[2]) -
        (c[0] - a[0]) * (b[2] - a[2]),
    ) / 2
  );
}
