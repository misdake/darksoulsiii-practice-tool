import * as THREE from "three";
import { activeRegions } from "./region-validation.js";

const GEOMETRY_EPSILON = 1e-7;

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
  const area = triangleAreaXZ(a, b, c);
  const subdivisions = Math.min(32, Math.max(1, Math.ceil(Math.sqrt(area))));
  for (let i = 1; i < subdivisions; i += 1) {
    for (let j = 1; j < subdivisions - i; j += 1) {
      const u = i / subdivisions;
      const v = j / subdivisions;
      const w = 1 - u - v;
      samples.push([
        a[0] * w + b[0] * u + c[0] * v,
        a[1] * w + b[1] * u + c[1] * v,
        a[2] * w + b[2] * u + c[2] * v,
      ]);
    }
  }
  const weight = samples.length ? area / samples.length : 0;
  for (const sample of samples) sample.coverageWeight = weight;
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
  const uncoveredArea = uncoveredPoints.reduce(
    (sum, point) => sum + (point.coverageWeight || 0),
    0,
  );
  const uncoveredRatio = targetArea ? uncoveredArea / targetArea : 0;
  const components = connectedSampleComponents(uncoveredPoints, cellSize);
  const largest = components[0] || {
    area: 0,
    count: 0,
    representative: null,
  };

  return {
    targetArea,
    uncoveredArea,
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
  return clipTrianglesToRegionPrism(triangles, region);
}

export function clipTrianglesToRegionPrism(triangles, region) {
  if (!Array.isArray(region?.polygon_xz) || region.polygon_xz.length < 3) {
    return [];
  }

  const polygon = region.polygon_xz.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(polygon, []);
  const regionTriangles = faces.map((face) => face.map((index) => polygon[index]));
  const clippedTriangles = [];

  for (const triangle of triangles) {
    const yClipped = clipPolygonByYRange(triangle, region.ymin, region.ymax);
    if (yClipped.length < 3 || polygonAreaXZ(yClipped) <= GEOMETRY_EPSILON) {
      continue;
    }

    for (const regionTriangle of regionTriangles) {
      const clipped = clipConvexPolygonXZ(yClipped, regionTriangle);
      if (clipped.length < 3) continue;
      for (let index = 1; index + 1 < clipped.length; index += 1) {
        const output = [clipped[0], clipped[index], clipped[index + 1]].map(
          (point) => [...point],
        );
        if (triangleAreaXZ(...output) > GEOMETRY_EPSILON) {
          clippedTriangles.push(output);
        }
      }
    }
  }

  return clippedTriangles;
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

export function triangleAreaXZ(a, b, c) {
  return (
    Math.abs(
      (b[0] - a[0]) * (c[2] - a[2]) -
        (c[0] - a[0]) * (b[2] - a[2]),
    ) / 2
  );
}

function clipPolygonByYRange(polygon, ymin, ymax) {
  return clipPolygonByScalar(
    clipPolygonByScalar(polygon, (point) => point[1] - ymin),
    (point) => ymax - point[1],
  );
}

function clipPolygonByScalar(polygon, distance) {
  const output = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentDistance = distance(current);
    const previousDistance = distance(previous);
    const currentInside = currentDistance >= -GEOMETRY_EPSILON;
    const previousInside = previousDistance >= -GEOMETRY_EPSILON;

    if (currentInside !== previousInside) {
      const denominator = previousDistance - currentDistance;
      const t = Math.abs(denominator) <= GEOMETRY_EPSILON
        ? 0
        : previousDistance / denominator;
      output.push(interpolatePoint(previous, current, t));
    }
    if (currentInside) output.push([...current]);
  }
  return dedupePolygon(output);
}

function clipConvexPolygonXZ(subject, clipTriangle) {
  let output = subject.map((point) => [...point]);
  const orientation = signedArea2D(clipTriangle) >= 0 ? 1 : -1;

  for (let edge = 0; edge < clipTriangle.length; edge += 1) {
    const edgeStart = clipTriangle[edge];
    const edgeEnd = clipTriangle[(edge + 1) % clipTriangle.length];
    const input = output;
    output = [];
    if (!input.length) break;

    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      const currentInside = isInsideEdge(current, edgeStart, edgeEnd, orientation);
      const previousInside = isInsideEdge(previous, edgeStart, edgeEnd, orientation);
      if (currentInside !== previousInside) {
        output.push(intersectSegmentWithLineXZ(previous, current, edgeStart, edgeEnd));
      }
      if (currentInside) output.push([...current]);
    }
    output = dedupePolygon(output);
  }

  return output;
}

function isInsideEdge(point, start, end, orientation) {
  return orientation * cross2D(
    end.x - start.x,
    end.y - start.y,
    point[0] - start.x,
    point[2] - start.y,
  ) >= -GEOMETRY_EPSILON;
}

function intersectSegmentWithLineXZ(from, to, lineStart, lineEnd) {
  const rx = to[0] - from[0];
  const rz = to[2] - from[2];
  const sx = lineEnd.x - lineStart.x;
  const sz = lineEnd.y - lineStart.y;
  const denominator = cross2D(rx, rz, sx, sz);
  if (Math.abs(denominator) <= GEOMETRY_EPSILON) return [...from];
  const t = cross2D(lineStart.x - from[0], lineStart.y - from[2], sx, sz) /
    denominator;
  return interpolatePoint(from, to, Math.max(0, Math.min(1, t)));
}

function interpolatePoint(from, to, t) {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}

function dedupePolygon(points) {
  const output = [];
  for (const point of points) {
    const previous = output.at(-1);
    if (!previous || pointDistanceSquared(previous, point) > GEOMETRY_EPSILON ** 2) {
      output.push(point);
    }
  }
  if (
    output.length > 1 &&
    pointDistanceSquared(output[0], output.at(-1)) <= GEOMETRY_EPSILON ** 2
  ) {
    output.pop();
  }
  return output;
}

function pointDistanceSquared(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function polygonAreaXZ(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a[0] * b[2] - b[0] * a[2];
  }
  return Math.abs(area) / 2;
}

function signedArea2D(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function cross2D(ax, az, bx, bz) {
  return ax * bz - az * bx;
}

function connectedSampleComponents(points, cellSize) {
  const cells = new Map();
  for (const point of points) {
    const key = gapMarkerKey(point, cellSize);
    const existing = cells.get(key);
    if (!existing) {
      cells.set(key, {
        point,
        weight: point.coverageWeight || 0,
      });
      continue;
    }
    existing.weight += point.coverageWeight || 0;
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

function createSampleComponent(entries, cellSize) {
  const representative = entries[0]?.point || null;
  return {
    count: entries.length,
    area: entries.reduce(
      (sum, entry) => sum + (entry.weight || cellSize * cellSize),
      0,
    ),
    representative,
  };
}

function neighborKeys(key) {
  const [x, y, z] = key.split(":").map(Number);
  const keys = [];
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        keys.push([x + dx, y + dy, z + dz].join(":"));
      }
    }
  }
  return keys;
}
