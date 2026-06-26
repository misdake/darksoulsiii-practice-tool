import {
  activeRegions,
  regionContainsGamePoint,
} from "./region-validation.js";

export function triangleCoverageSamples(a, b, c) {
  const samples = [
    a,
    b,
    c,
    [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ],
  ];
  const area2 = Math.abs(
    (b[0] - a[0]) * (c[2] - a[2]) -
      (c[0] - a[0]) * (b[2] - a[2]),
  );
  if (area2 > 4) {
    samples.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  }
  return samples;
}

export function findUncoveredSamples(regions, triangles) {
  const uncovered = [];
  for (const triangle of triangles) {
    for (const point of triangleCoverageSamples(...triangle)) {
      if (!activeRegions(regions, point).length) {
        uncovered.push(point);
      }
    }
  }
  return uncovered;
}

export function summarizeUncoveredCoverage(uncoveredPoints, triangles, cellSize = 1) {
  const targetArea = triangles.reduce(
    (sum, triangle) => sum + triangleAreaXZ(...triangle),
    0,
  );
  const totalSamples = triangles.reduce(
    (sum, triangle) => sum + triangleCoverageSamples(...triangle).length,
    0,
  );
  const uncoveredRatio = totalSamples
    ? uncoveredPoints.length / totalSamples
    : 0;
  const components = connectedSampleComponents(uncoveredPoints, cellSize);
  const largest = components[0] || {
    area: 0,
    count: 0,
    representative: null,
  };

  return {
    targetArea,
    uncoveredArea: targetArea * uncoveredRatio,
    uncoveredRatio,
    largestComponentArea: largest.area,
    largestComponentCount: largest.count,
    representative: largest.representative,
    componentCount: components.length,
    sampleCount: uncoveredPoints.length,
  };
}

/** A stable grid key used for the transient Stage 5 gap-marker set. */
export function gapMarkerKey([x, y, z], cellSize = 0.5) {
  return [x, y, z].map((value) => Math.floor(value / cellSize)).join(":");
}

export function addGapMarker(markers, point, cellSize = 0.5) {
  const key = gapMarkerKey(point, cellSize);
  if (markers.has(key)) {
    return false;
  }
  markers.set(key, [...point]);
  return true;
}

export function filterTrianglesForRegion(triangles, region) {
  return triangles.filter((triangle) =>
    triangle.some((point) => regionContainsGamePoint(region, point)),
  );
}

export function footprintForHeight(config, height) {
  const aspect = Math.max(1e-6, config.render_width / config.render_height);
  const halfHeight =
    Math.tan(Math.max(1e-4, config.fov_y_rad / 2)) * Math.max(0, height);
  return { width: halfHeight * 2 * aspect, height: halfHeight * 2 };
}

export function replenishCoverageCandidates(candidates, accepted, footprint) {
  const halfX = footprint.width / 2;
  const halfZ = footprint.height / 2;

  return candidates.filter(
    (candidate) =>
      !accepted.some(
        (camera) =>
          Math.abs(camera.x - candidate.x) <= halfX &&
          Math.abs(camera.z - candidate.z) <= halfZ,
      ),
  );
}

function triangleAreaXZ(a, b, c) {
  return (
    Math.abs(
      (b[0] - a[0]) * (c[2] - a[2]) -
        (c[0] - a[0]) * (b[2] - a[2]),
    ) / 2
  );
}

function connectedSampleComponents(points, cellSize) {
  const cells = new Map();
  for (const point of points) {
    const key = gapMarkerKey(point, cellSize);
    if (!cells.has(key)) {
      cells.set(key, point);
    }
  }

  const visited = new Set();
  const components = [];
  for (const key of cells.keys()) {
    if (visited.has(key)) continue;
    const queue = [key];
    const members = [];
    visited.add(key);
    while (queue.length) {
      const current = queue.pop();
      members.push(cells.get(current));
      for (const neighbor of neighborKeys(current)) {
        if (!cells.has(neighbor) || visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(createSampleComponent(members, cellSize));
  }

  return components.sort((a, b) => b.area - a.area);
}

function createSampleComponent(points, cellSize) {
  const representative = points[0] || null;
  return {
    count: points.length,
    area: points.length * cellSize * cellSize,
    representative,
  };
}

function neighborKeys(key) {
  const [x, y, z] = key.split(":").map(Number);
  const keys = [];
  for (const dx of [-1, 0, 1]) {
    for (const dz of [-1, 0, 1]) {
      if (dx === 0 && dz === 0) continue;
      keys.push([x + dx, y, z + dz].join(":"));
    }
  }
  return keys;
}
