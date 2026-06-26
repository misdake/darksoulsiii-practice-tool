import { signedArea } from "./region-polygon-geometry.js";
import { collectCellComponent } from "./region-cell-components.js";

export function polygonComponentsFromCells(cells, cellSize) {
  const components = [];
  while (cells.size) {
    const first = cells.values().next().value;
    const component = collectCellComponent(cells, first);
    const outer = largestLoop(loopsForComponent(component));
    const simplified = simplifyAxisAlignedLoop(outer);
    if (simplified.length >= 3) {
      components.push(simplified.map(([x, z]) => [x * cellSize, z * cellSize]));
    }
  }
  return components;
}

function largestLoop(loops) {
  return (
    loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))[0] ||
    []
  );
}

function loopsForComponent(component) {
  const componentSet = new Set(component.map(([x, z]) => `${x}:${z}`));
  const edges = new Map();
  const addEdge = (a, b) => edges.set(`${a[0]}:${a[1]}`, b);

  for (const [x, z] of component) {
    if (!componentSet.has(`${x}:${z - 1}`)) {
      addEdge([x, z], [x + 1, z]);
    }
    if (!componentSet.has(`${x + 1}:${z}`)) {
      addEdge([x + 1, z], [x + 1, z + 1]);
    }
    if (!componentSet.has(`${x}:${z + 1}`)) {
      addEdge([x + 1, z + 1], [x, z + 1]);
    }
    if (!componentSet.has(`${x - 1}:${z}`)) {
      addEdge([x, z + 1], [x, z]);
    }
  }

  return collectLoops(edges);
}

function collectLoops(edges) {
  const loops = [];
  while (edges.size) {
    const first = edges.entries().next().value;
    const start = first[0].split(":").map(Number);
    const loop = [start];
    let next = first[1];
    edges.delete(first[0]);
    while (next && (next[0] !== start[0] || next[1] !== start[1])) {
      loop.push(next);
      const key = `${next[0]}:${next[1]}`;
      next = edges.get(key);
      edges.delete(key);
    }
    loops.push(loop);
  }
  return loops;
}

function simplifyAxisAlignedLoop(points) {
  return points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    return (
      (point[0] - previous[0]) * (next[1] - point[1]) !==
      (point[1] - previous[1]) * (next[0] - point[0])
    );
  });
}
