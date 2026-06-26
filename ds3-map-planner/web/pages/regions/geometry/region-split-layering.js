export function splitAabb(triangles) {
  const out = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };

  for (const triangle of triangles) {
    for (const [x, y, z] of triangle) {
      out.minX = Math.min(out.minX, x);
      out.maxX = Math.max(out.maxX, x);
      out.minY = Math.min(out.minY, y);
      out.maxY = Math.max(out.maxY, y);
      out.minZ = Math.min(out.minZ, z);
      out.maxZ = Math.max(out.maxZ, z);
    }
  }

  return out;
}

export function aabbsOverlapXZ(a, b) {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ
  );
}

/**
 * Groups whole selected navmesh splits into height layers. A split is never
 * cut: overlapping XZ splits whose vertical ranges are separated get distinct
 * layers, while peers at approximately the same floor height share a layer.
 */
export function groupSplitsByLayer(splits, heightEpsilon = 0.75) {
  const layers = [];
  for (const split of splits) {
    const bounds = splitAabb(split.triangles);
    const floor = bounds.minY;
    let layer = layers.find(
      (candidate) =>
        Math.abs(candidate.ymin - floor) <= heightEpsilon &&
        candidate.members.some((member) =>
          aabbsOverlapXZ(member.bounds, bounds),
        ),
    );
    if (!layer) {
      layer = { ymin: floor, ymax: bounds.maxY, members: [] };
      layers.push(layer);
    }
    layer.members.push({ ...split, bounds });
    layer.ymin = Math.min(layer.ymin, floor);
    layer.ymax = Math.max(layer.ymax, bounds.maxY);
  }
  return layers.sort((a, b) => a.ymin - b.ymin);
}
