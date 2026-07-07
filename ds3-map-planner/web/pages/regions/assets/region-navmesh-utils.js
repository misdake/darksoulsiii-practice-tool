import * as THREE from "three";

const DEFAULT_REGION_MIN = new THREE.Vector3(-5, 0, -5);
const DEFAULT_REGION_MAX = new THREE.Vector3(5, 0, 5);
const DEFAULT_REGION_HEIGHT = 3;
const DEFAULT_REGION_FLOOR_PADDING = 0.5;
const AUTO_REGION_Y_PRECISION = 100;

export function trianglesFromMesh(mesh) {
  const position = mesh.geometry.getAttribute("position");
  const index = mesh.geometry.index;
  const triangleCount = index ? index.count : position.count;
  const triangles = [];

  for (let offset = 0; offset + 2 < triangleCount; offset += 3) {
    triangles.push([
      meshVertexAt(position, index, offset),
      meshVertexAt(position, index, offset + 1),
      meshVertexAt(position, index, offset + 2),
    ]);
  }

  return triangles;
}

export function collectNavmeshTriangles(navGroup) {
  return navGroup.children.flatMap((mesh) => trianglesFromMesh(mesh));
}

export function createRegionFromMesh(mesh, index) {
  return createRegionFromMeshes([mesh], index);
}

export function createRegionFromMeshes(meshes, index) {
  const geometry = collectMeshWorldGeometry(meshes);
  const ymin = roundAutoRegionY(geometry.minY - DEFAULT_REGION_FLOOR_PADDING);
  const ymax = roundAutoRegionY(geometry.maxY + DEFAULT_REGION_HEIGHT);

  return {
    name: `Region ${index + 1}`,
    ymin,
    ymax,
    polygon_xz: minimumAreaBoundingRectangle(geometry.pointsXZ),
  };
}

function meshVertexAt(position, index, offset) {
  const vertexIndex = index ? index.getX(offset) : offset;
  return [
    position.getX(vertexIndex),
    position.getY(vertexIndex),
    position.getZ(vertexIndex),
  ];
}

function collectMeshWorldGeometry(meshes) {
  const pointsXZ = [];
  let minY = Infinity;
  let maxY = -Infinity;
  const worldVertex = new THREE.Vector3();
  for (const mesh of meshes || []) {
    if (!mesh?.isMesh) continue;
    const position = mesh.geometry?.getAttribute("position");
    if (!position) continue;
    mesh.updateWorldMatrix(true, false);
    for (let index = 0; index < position.count; index += 1) {
      worldVertex.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
      pointsXZ.push([worldVertex.x, worldVertex.z]);
      minY = Math.min(minY, worldVertex.y);
      maxY = Math.max(maxY, worldVertex.y);
    }
  }
  return pointsXZ.length
    ? { pointsXZ, minY, maxY }
    : {
        pointsXZ: boundsToGamePolygon({ min: DEFAULT_REGION_MIN, max: DEFAULT_REGION_MAX }),
        minY: DEFAULT_REGION_MIN.y,
        maxY: DEFAULT_REGION_MAX.y,
      };
}

export function minimumAreaBoundingRectangle(points) {
  const hull = convexHull(points);
  if (hull.length < 3) return axisAlignedRectangle(points);

  let best = null;
  for (let index = 0; index < hull.length; index += 1) {
    const [ax, az] = hull[index];
    const [bx, bz] = hull[(index + 1) % hull.length];
    const length = Math.hypot(bx - ax, bz - az);
    if (length <= Number.EPSILON) continue;
    const ux = (bx - ax) / length;
    const uz = (bz - az) / length;
    const vx = -uz;
    const vz = ux;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, z] of hull) {
      const u = x * ux + z * uz;
      const v = x * vx + z * vz;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area - 1e-9) {
      best = { area, ux, uz, vx, vz, minU, maxU, minV, maxV };
    }
  }
  if (!best) return axisAlignedRectangle(points);
  const toWorld = (u, v) => [u * best.ux + v * best.vx, u * best.uz + v * best.vz];
  return normalizeRectangleStart([
    toWorld(best.minU, best.minV),
    toWorld(best.maxU, best.minV),
    toWorld(best.maxU, best.maxV),
    toWorld(best.minU, best.maxV),
  ]);
}

function convexHull(points) {
  const sorted = [...new Map(points.map(([x, z]) => [`${x}:${z}`, [x, z]])).values()]
    .sort(([ax, az], [bx, bz]) => ax - bx || az - bz);
  if (sorted.length <= 1) return sorted;
  const cross = (origin, a, b) =>
    (a[0] - origin[0]) * (b[1] - origin[1]) -
    (a[1] - origin[1]) * (b[0] - origin[0]);
  const buildHalf = (ordered) => {
    const half = [];
    for (const point of ordered) {
      while (half.length >= 2 && cross(half.at(-2), half.at(-1), point) <= 0) half.pop();
      half.push(point);
    }
    return half;
  };
  const lower = buildHalf(sorted);
  const upper = buildHalf([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function axisAlignedRectangle(points) {
  if (!points.length) return boundsToGamePolygon({ min: DEFAULT_REGION_MIN, max: DEFAULT_REGION_MAX });
  const xs = points.map(([x]) => x);
  const zs = points.map(([, z]) => z);
  return boundsToGamePolygon({
    min: { x: Math.min(...xs), z: Math.min(...zs) },
    max: { x: Math.max(...xs), z: Math.max(...zs) },
  });
}

function normalizeRectangleStart(rectangle) {
  let start = 0;
  for (let index = 1; index < rectangle.length; index += 1) {
    if (rectangle[index][0] < rectangle[start][0] - 1e-9 ||
        (Math.abs(rectangle[index][0] - rectangle[start][0]) <= 1e-9 && rectangle[index][1] < rectangle[start][1])) {
      start = index;
    }
  }
  return [...rectangle.slice(start), ...rectangle.slice(0, start)];
}

function boundsToGamePolygon({ min, max }) {
  return [
    [min.x, min.z],
    [max.x, min.z],
    [max.x, max.z],
    [min.x, max.z],
  ];
}

function roundAutoRegionY(y) {
  return Math.round(y * AUTO_REGION_Y_PRECISION) / AUTO_REGION_Y_PRECISION;
}
