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
