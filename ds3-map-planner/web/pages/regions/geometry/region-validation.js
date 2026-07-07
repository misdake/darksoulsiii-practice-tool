import {
  EPSILON,
  hasSelfIntersection,
  pointInPolygon,
  signedArea,
} from "./region-polygon-geometry.js";
import { isValidUuid } from "../state/region-state.js";

/**
 * Validates one prism.
 *
 * @param {object} prism
 * @returns {string | null} `null` when valid; otherwise a user-facing error.
 */
export function validatePrism(prism) {
  if (
    !prism ||
    !Number.isFinite(prism.ymin) ||
    !Number.isFinite(prism.ymax) ||
    prism.ymin >= prism.ymax
  ) {
    return "ymin must be smaller than ymax.";
  }
  const polygon = prism.polygon_xz;
  if (
    !Array.isArray(polygon) ||
    polygon.length < 3 ||
    polygon.some((vertex) =>
      !Array.isArray(vertex) || vertex.length !== 2 || !vertex.every(Number.isFinite))
  ) {
    return "A prism needs at least three finite XZ vertices.";
  }
  if (Math.abs(signedArea(polygon)) < EPSILON) {
    return "Prism vertices must not be collinear.";
  }
  if (hasSelfIntersection(polygon)) {
    return "Prism polygon must not self-intersect.";
  }
  return null;
}

export function validateRegionGroups(groups) {
  if (!Array.isArray(groups)) return "region_groups must be an array.";
  const uuids = new Set();
  for (const group of groups) {
    if (!isValidUuid(group?.uuid)) return "Every region group needs a valid UUID.";
    if (uuids.has(group.uuid)) return `Region group UUID '${group.uuid}' is duplicated.`;
    uuids.add(group.uuid);
    if (typeof group.name !== "string" || !group.name.trim()) {
      return "Region group name is required.";
    }
    if (!isIsoTimestamp(group.last_updated)) {
      return `Region group '${group.name}' needs a valid last_updated timestamp.`;
    }
    if (!Array.isArray(group.prisms) || !group.prisms.length) {
      return `Region group '${group.name}' needs at least one prism.`;
    }
    for (const prism of group.prisms) {
      const error = validatePrism(prism);
      if (error) return `${group.name}: ${error}`;
      const keys = Object.keys(prism).sort();
      if (keys.join(",") !== "polygon_xz,ymax,ymin") {
        return `${group.name}: prism fields must be ymin, ymax and polygon_xz only.`;
      }
    }
  }
  return null;
}

export function prismContainsGamePoint(prism, [x, y, z]) {
  return y >= prism.ymin - EPSILON &&
    y <= prism.ymax + EPSILON &&
    pointInPolygon([x, z], prism.polygon_xz);
}

export function activeRegionGroups(groups, point) {
  return groups.filter((group) => group.prisms.some((prism) => prismContainsGamePoint(prism, point)));
}

export function prismAabb(prism) {
  const xs = prism.polygon_xz.map(([x]) => x);
  const zs = prism.polygon_xz.map(([, z]) => z);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs), minY: prism.ymin,
    maxY: prism.ymax, minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

// Temporary aliases keep geometry/rendering callers small while terminology migrates.
export const validateRegion = validatePrism;
export function validateRegions(regions) {
  if (!Array.isArray(regions)) return "prisms must be an array.";
  for (const prism of regions) {
    const error = validatePrism(prism);
    if (error) return error;
  }
  return null;
}
export const regionContainsGamePoint = prismContainsGamePoint;
export const regionAabb = prismAabb;
export function activeRegions(prisms, point) {
  return prisms.filter((prism) => prismContainsGamePoint(prism, point))
    .sort((a, b) => a.ymin - b.ymin || prisms.indexOf(a) - prisms.indexOf(b));
}

export function findRegionGroupOverlaps(groups, tolerance = 0.1) {
  const overlaps = [];
  // The 0.1m tolerance deliberately ignores touching borders and tiny digitization noise.
  for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
      for (const [leftPrismIndex, left] of groups[leftIndex].prisms.entries()) {
        for (const [rightPrismIndex, right] of groups[rightIndex].prisms.entries()) {
          const yOverlap = Math.min(left.ymax, right.ymax) - Math.max(left.ymin, right.ymin);
          if (yOverlap <= tolerance) continue;
          const a = prismAabb(left);
          const b = prismAabb(right);
          if (Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) <= tolerance ||
              Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) <= tolerance) continue;
          if (polygonsOverlapBeyondTolerance(left.polygon_xz, right.polygon_xz, tolerance)) {
            overlaps.push({
              leftGroup: groups[leftIndex],
              leftGroupIndex: leftIndex,
              leftPrismIndex,
              rightGroup: groups[rightIndex],
              rightGroupIndex: rightIndex,
              rightPrismIndex,
              yOverlap,
            });
          }
        }
      }
    }
  }
  return overlaps;
}

function polygonsOverlapBeyondTolerance(left, right, tolerance) {
  return left.some(([x, z]) => pointInPolygon([x, z], right) && distanceToPolygonEdges([x, z], right) > tolerance) ||
    right.some(([x, z]) => pointInPolygon([x, z], left) && distanceToPolygonEdges([x, z], left) > tolerance) ||
    hasProperEdgeIntersection(left, right);
}

function hasProperEdgeIntersection(left, right) {
  for (let a = 0; a < left.length; a += 1) {
    for (let b = 0; b < right.length; b += 1) {
      if (segmentsProperlyIntersect(left[a], left[(a + 1) % left.length], right[b], right[(b + 1) % right.length])) return true;
    }
  }
  return false;
}

function segmentsProperlyIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < -EPSILON && cdA * cdB < -EPSILON;
}

function distanceToPolygonEdges(point, polygon) {
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    distance = Math.min(distance, pointSegmentDistance(point, polygon[index], polygon[(index + 1) % polygon.length]));
  }
  return distance;
}

function pointSegmentDistance([px, pz], [ax, az], [bx, bz]) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
