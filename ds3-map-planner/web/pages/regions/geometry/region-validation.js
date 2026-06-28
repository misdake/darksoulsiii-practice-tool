import * as THREE from "three";
import {
  EPSILON,
  hasSelfIntersection,
  pointInPolygon,
  signedArea,
} from "./region-polygon-geometry.js";

export function validateRegion(region, names = new Set()) {
  if (!region || typeof region.name !== "string" || !region.name.trim()) {
    return "Region name is required.";
  }
  if (names.has(region.name.trim())) {
    return `Region name '${region.name.trim()}' is duplicated.`;
  }
  if (
    !Number.isFinite(region.ymin) ||
    !Number.isFinite(region.ymax) ||
    region.ymin >= region.ymax
  ) {
    return "ymin must be smaller than ymax.";
  }

  const p = region.polygon_xz;
  if (
    !Array.isArray(p) ||
    p.length < 3 ||
    p.some(
      (v) => !Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite),
    )
  ) {
    return "A region needs at least three finite XZ vertices.";
  }
  if (Math.abs(signedArea(p)) < EPSILON) {
    return "Region vertices must not be collinear.";
  }
  if (hasSelfIntersection(p)) {
    return "Region polygon must not self-intersect.";
  }
  return null;
}

export function validateRegions(regions) {
  if (!Array.isArray(regions)) {
    return "regions must be an array.";
  }

  const names = new Set();
  for (const region of regions) {
    const error = validateRegion(region, names);
    if (error) {
      return error;
    }
    names.add(region.name.trim());
  }
  return null;
}

export function regionContainsGamePoint(region, [x, y, z]) {
  return (
    y >= region.ymin - EPSILON &&
    y <= region.ymax + EPSILON &&
    pointInPolygon([x, z], region.polygon_xz)
  );
}

export function activeRegions(regions, point) {
  return regions
    .filter((r) => regionContainsGamePoint(r, point))
    .sort((a, b) => a.ymin - b.ymin || regions.indexOf(a) - regions.indexOf(b));
}

export function findCrossGroupRegionOverlaps(
  regions,
  regionGroups,
  tolerance = 0.1,
) {
  const groupByName = new Map();
  for (const [index, group] of (regionGroups || []).entries()) {
    for (const name of group.regions || []) groupByName.set(name, `group:${index}`);
  }
  const groupKey = (region) =>
    groupByName.get(region.name) || `region:${region.name}`;
  const triangles = new Map(
    regions.map((region) => [region, triangulatePolygon(region.polygon_xz)]),
  );
  const overlaps = [];

  for (let firstIndex = 0; firstIndex < regions.length; firstIndex += 1) {
    const first = regions[firstIndex];
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < regions.length;
      secondIndex += 1
    ) {
      const second = regions[secondIndex];
      if (groupKey(first) === groupKey(second)) continue;
      if (
        Math.min(first.ymax, second.ymax) -
          Math.max(first.ymin, second.ymin) <=
        EPSILON
      ) {
        continue;
      }
      if (
        polygonsOverlapBeyondTolerance(
          triangles.get(first),
          triangles.get(second),
          tolerance,
        )
      ) {
        overlaps.push({ first, second });
      }
    }
  }
  return overlaps;
}

export function regionAabb(region) {
  const xs = region.polygon_xz.map(([x]) => x);
  const zs = region.polygon_xz.map(([, z]) => z);

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: region.ymin,
    maxY: region.ymax,
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

function triangulatePolygon(polygon) {
  const points = polygon.map(([x, z]) => new THREE.Vector2(x, z));
  return THREE.ShapeUtils.triangulateShape(points, []).map((face) =>
    face.map((index) => polygon[index]),
  );
}

function polygonsOverlapBeyondTolerance(first, second, tolerance) {
  for (const firstTriangle of first) {
    for (const secondTriangle of second) {
      const intersection = clipConvexPolygon(firstTriangle, secondTriangle);
      if (minimumPolygonWidth(intersection) > tolerance + EPSILON) return true;
    }
  }
  return false;
}

function clipConvexPolygon(subject, clip) {
  let output = subject.map((point) => [...point]);
  const orientation = Math.sign(signedArea(clip)) || 1;
  for (let index = 0; index < clip.length && output.length; index += 1) {
    const edgeStart = clip[index];
    const edgeEnd = clip[(index + 1) % clip.length];
    const input = output;
    output = [];
    for (let pointIndex = 0; pointIndex < input.length; pointIndex += 1) {
      const current = input[pointIndex];
      const previous = input[(pointIndex + input.length - 1) % input.length];
      const currentInside = isInsideEdge(
        current,
        edgeStart,
        edgeEnd,
        orientation,
      );
      const previousInside = isInsideEdge(
        previous,
        edgeStart,
        edgeEnd,
        orientation,
      );
      if (currentInside !== previousInside) {
        output.push(lineIntersection(previous, current, edgeStart, edgeEnd));
      }
      if (currentInside) output.push(current);
    }
  }
  return output;
}

function isInsideEdge(point, start, end, orientation) {
  return orientation * cross2(subtract2(end, start), subtract2(point, start)) >= -EPSILON;
}

function lineIntersection(firstStart, firstEnd, secondStart, secondEnd) {
  const firstDirection = subtract2(firstEnd, firstStart);
  const secondDirection = subtract2(secondEnd, secondStart);
  const denominator = cross2(firstDirection, secondDirection);
  if (Math.abs(denominator) <= EPSILON) return [...firstEnd];
  const amount =
    cross2(subtract2(secondStart, firstStart), secondDirection) / denominator;
  return [
    firstStart[0] + firstDirection[0] * amount,
    firstStart[1] + firstDirection[1] * amount,
  ];
}

function minimumPolygonWidth(polygon) {
  if (polygon.length < 3) return 0;
  let minimum = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const edge = subtract2(polygon[(index + 1) % polygon.length], polygon[index]);
    const length = Math.hypot(edge[0], edge[1]);
    if (length <= EPSILON) continue;
    const normal = [-edge[1] / length, edge[0] / length];
    const projections = polygon.map(
      (point) => point[0] * normal[0] + point[1] * normal[1],
    );
    minimum = Math.min(minimum, Math.max(...projections) - Math.min(...projections));
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

function subtract2(first, second) {
  return [first[0] - second[0], first[1] - second[1]];
}

function cross2(first, second) {
  return first[0] * second[1] - first[1] * second[0];
}
