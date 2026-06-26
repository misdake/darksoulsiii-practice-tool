import {
  EPSILON,
  cross,
} from "./region-polygon-geometry.js";
import { polygonComponentsFromCells } from "./region-cell-contours.js";

export function occupancyBoundsFromTriangles(triangles, cellSize = 1) {
  const cells = new Set();
  for (const triangle of triangles) {
    const xs = triangle.map(([x]) => x);
    const zs = triangle.map(([, , z]) => z);
    const minX = Math.floor(Math.min(...xs) / cellSize);
    const maxX = Math.floor(Math.max(...xs) / cellSize);
    const minZ = Math.floor(Math.min(...zs) / cellSize);
    const maxZ = Math.floor(Math.max(...zs) / cellSize);

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (cellCenterIntersectsTriangle(x, z, cellSize, triangle)) {
          cells.add(`${x}:${z}`);
        }
      }
    }
  }

  return polygonComponentsFromCells(cells, cellSize);
}

function cellCenterIntersectsTriangle(x, z, cellSize, triangle) {
  const center = [(x + 0.5) * cellSize, (z + 0.5) * cellSize];
  const a = [triangle[0][0], triangle[0][2]];
  const b = [triangle[1][0], triangle[1][2]];
  const c = [triangle[2][0], triangle[2][2]];
  const signs = [
    cross(a, b, center),
    cross(b, c, center),
    cross(c, a, center),
  ];
  return (
    signs.every((value) => value >= -EPSILON) ||
    signs.every((value) => value <= EPSILON)
  );
}
