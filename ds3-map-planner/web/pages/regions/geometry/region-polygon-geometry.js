export const EPSILON = 1e-8;

export function signedArea(points) {
  return (
    points.reduce((sum, [x, z], i) => {
      const [nextX, nextZ] = points[(i + 1) % points.length];
      return sum + x * nextZ - nextX * z;
    }, 0) / 2
  );
}

export function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function onSegment(a, b, p) {
  return (
    Math.abs(cross(a, b, p)) < EPSILON &&
    p[0] >= Math.min(a[0], b[0]) - EPSILON &&
    p[0] <= Math.max(a[0], b[0]) + EPSILON &&
    p[1] >= Math.min(a[1], b[1]) - EPSILON &&
    p[1] <= Math.max(a[1], b[1]) + EPSILON
  );
}

export function segmentsIntersect(a, b, c, d) {
  const ac = cross(a, b, c);
  const ad = cross(a, b, d);
  const ca = cross(c, d, a);
  const cb = cross(c, d, b);

  if (
    ((ac > EPSILON && ad < -EPSILON) || (ac < -EPSILON && ad > EPSILON)) &&
    ((ca > EPSILON && cb < -EPSILON) || (ca < -EPSILON && cb > EPSILON))
  ) {
    return true;
  }

  return (
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}

export function hasSelfIntersection(points) {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if ((i + 1) % points.length === j || (j + 1) % points.length === i) {
        continue;
      }
      if (
        segmentsIntersect(
          points[i],
          points[(i + 1) % points.length],
          points[j],
          points[(j + 1) % points.length],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function pointInPolygon([x, z], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];

    if (onSegment(a, b, [x, z])) {
      return true;
    }

    if (
      a[1] > z !== b[1] > z &&
      x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function closestPolygonEdgeInsertion(polygon, point) {
  let best = { index: 0, distanceSq: Infinity };
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lengthSq = dx * dx + dz * dz;
    const t =
      lengthSq === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSq,
            ),
          );
    const x = a[0] + dx * t;
    const z = a[1] + dz * t;
    const distanceSq = (point[0] - x) ** 2 + (point[1] - z) ** 2;
    if (distanceSq < best.distanceSq) {
      best = { index: index + 1, distanceSq };
    }
  }
  return best;
}
