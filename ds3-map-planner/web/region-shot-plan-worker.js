const HEIGHT_LAYER_SIZE = 0.5;

if (typeof self !== "undefined") {
  self.onmessage = ({ data }) => {
    try {
      const result = calculateRegionShotCandidates(data.triangleData, data.config);
      self.postMessage({ id: data.id, ok: true, result });
    } catch (error) {
      self.postMessage({
        id: data.id,
        ok: false,
        error: error?.message || String(error),
      });
    }
  };
}

export function calculateRegionShotCandidates(triangleData, config) {
  const triangles = unpackTriangles(triangleData);
  if (!triangles.length) {
    throw new Error("selected region contains no navmesh triangles");
  }

  const metrics = createCoverageMetrics(config);
  const bounds = triangleBounds(triangles);
  const targetCells = createTargetCells(triangles, bounds, metrics.cellSize);
  const points = createInitialCandidates(targetCells, bounds, metrics, config);
  const localCandidates = targetCells.map((cell, index) =>
    createCandidate(cell, config, metrics.cameraHeight, index, true),
  );

  return {
    coord_space: "world",
    version: 2,
    config: { ...config },
    density_px_per_wu: metrics.density,
    render_width: config.render_width,
    render_height: config.render_height,
    fov_y_rad: config.fov_y_rad,
    camera_height_from_y_ref: metrics.cameraHeight,
    coverage_width: metrics.coverageWidth,
    coverage_height: metrics.coverageHeight,
    overlap_ratio: metrics.overlap,
    step_x: metrics.stepX,
    step_z: metrics.stepZ,
    cell_size: metrics.cellSize,
    wait_load_ms: config.wait_load_ms,
    wait_shot_ms: config.wait_shot_ms,
    camera: {
      direction: [0, -1, 0],
      up: [0, 0, -1],
      near: 0.1,
      far: Math.max(1000, metrics.cameraHeight * 2),
    },
    points,
    target_cells: targetCells,
    local_candidates: localCandidates,
    stats: {
      triangles: triangles.length,
      candidate_points: points.length,
      local_candidate_points: localCandidates.length,
      target_cells: targetCells.length,
    },
  };
}

function unpackTriangles(buffer) {
  const values = new Float32Array(buffer);
  const triangles = [];
  for (let offset = 0; offset + 8 < values.length; offset += 9) {
    triangles.push(Array.from(values.subarray(offset, offset + 9)));
  }
  return triangles;
}

function createCoverageMetrics(config) {
  const density =
    Math.max(1e-6, config.base_ratio_px_per_wu) *
    Math.max(1e-6, config.density_multiplier);
  const overlap = Math.max(0, Math.min(0.95, config.overlap_ratio));
  const coverageHeight = config.render_height / density;
  const coverageWidth = config.render_width / density;
  const stepX = Math.max(0.01, coverageWidth * (1 - overlap));
  const stepZ = Math.max(0.01, coverageHeight * (1 - overlap));
  const halfFov = Math.max(
    1e-4,
    Math.min(Math.PI * 0.5 - 1e-4, config.fov_y_rad * 0.5),
  );
  const cameraHeight =
    (coverageHeight * 0.5) / Math.max(1e-6, Math.tan(halfFov));
  return {
    density,
    overlap,
    coverageHeight,
    coverageWidth,
    stepX,
    stepZ,
    cameraHeight,
    cellSize: Math.max(0.25, Math.min(1, Math.min(stepX, stepZ) / 4)),
  };
}

function createTargetCells(triangles, bounds, cellSize) {
  const cells = new Map();
  for (const triangle of triangles) {
    const area = triangleAreaXZ(triangle);
    if (area <= 1e-8) continue;
    const samples = triangleGridSamples(triangle, bounds, cellSize);
    const sampleWeight = area / samples.length;
    for (const sample of samples) {
      const ix = Math.floor((sample.x - bounds.minX) / cellSize);
      const iz = Math.floor((sample.z - bounds.minZ) / cellSize);
      const layer = Math.round(sample.y / HEIGHT_LAYER_SIZE);
      const key = `${ix}:${iz}:${layer}`;
      const cell = cells.get(key) || {
        key,
        ix,
        iz,
        layer,
        x: 0,
        y_ref: 0,
        z: 0,
        area: 0,
        accumulated_area: 0,
      };
      cell.x += sample.x * sampleWeight;
      cell.y_ref += sample.y * sampleWeight;
      cell.z += sample.z * sampleWeight;
      cell.accumulated_area += sampleWeight;
      // A cell/layer is a union target. Taking the largest contribution avoids
      // double-counting the same surface when group prisms overlap.
      cell.area = Math.min(cellSize * cellSize, Math.max(cell.area, sampleWeight));
      cells.set(key, cell);
    }
  }

  return [...cells.values()].map((cell) => ({
    ...cell,
    x: cell.x / cell.accumulated_area,
    y_ref: cell.y_ref / cell.accumulated_area,
    z: cell.z / cell.accumulated_area,
    accumulated_area: undefined,
  }));
}

function triangleGridSamples(triangle, bounds, cellSize) {
  const xs = [triangle[0], triangle[3], triangle[6]];
  const zs = [triangle[2], triangle[5], triangle[8]];
  const ix0 = Math.floor((Math.min(...xs) - bounds.minX) / cellSize);
  const ix1 = Math.floor((Math.max(...xs) - bounds.minX) / cellSize);
  const iz0 = Math.floor((Math.min(...zs) - bounds.minZ) / cellSize);
  const iz1 = Math.floor((Math.max(...zs) - bounds.minZ) / cellSize);
  const samples = [];

  for (let iz = iz0; iz <= iz1; iz += 1) {
    for (let ix = ix0; ix <= ix1; ix += 1) {
      const x = bounds.minX + (ix + 0.5) * cellSize;
      const z = bounds.minZ + (iz + 0.5) * cellSize;
      const y = barycentricHeight(x, z, triangle);
      if (y !== null) samples.push({ x, y, z });
    }
  }

  if (!samples.length) {
    samples.push({
      x: (triangle[0] + triangle[3] + triangle[6]) / 3,
      y: (triangle[1] + triangle[4] + triangle[7]) / 3,
      z: (triangle[2] + triangle[5] + triangle[8]) / 3,
    });
  }
  return samples;
}

function createInitialCandidates(cells, bounds, metrics, config) {
  const bins = new Map();
  for (const cell of cells) {
    const ix = Math.floor((cell.x - bounds.minX) / metrics.stepX);
    const iz = Math.floor((cell.z - bounds.minZ) / metrics.stepZ);
    const key = `${ix}:${iz}:${cell.layer}`;
    const bin = bins.get(key) || { cells: [], area: 0, x: 0, z: 0 };
    bin.cells.push(cell);
    bin.area += cell.area;
    bin.x += cell.x * cell.area;
    bin.z += cell.z * cell.area;
    bins.set(key, bin);
  }

  return [...bins.values()].map((bin, index) => {
    const centerX = bin.x / bin.area;
    const centerZ = bin.z / bin.area;
    const anchor = bin.cells.reduce((best, cell) =>
      distanceSquared(cell, centerX, centerZ) < distanceSquared(best, centerX, centerZ)
        ? cell
        : best,
    );
    return createCandidate(anchor, config, metrics.cameraHeight, index, false);
  });
}

function createCandidate(cell, config, cameraHeight, id, replenished) {
  return {
    id,
    x: cell.x,
    y_ref: cell.y_ref,
    y: cell.y_ref + cameraHeight + config.y_lift,
    z: cell.z,
    layer: cell.layer,
    replenished,
  };
}

function triangleBounds(triangles) {
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const triangle of triangles) {
    for (let offset = 0; offset < 9; offset += 3) {
      bounds.minX = Math.min(bounds.minX, triangle[offset]);
      bounds.maxX = Math.max(bounds.maxX, triangle[offset]);
      bounds.minZ = Math.min(bounds.minZ, triangle[offset + 2]);
      bounds.maxZ = Math.max(bounds.maxZ, triangle[offset + 2]);
    }
  }
  return bounds;
}

function barycentricHeight(x, z, triangle) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = triangle;
  const denominator = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
  if (Math.abs(denominator) <= 1e-8) return null;
  const v = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / denominator;
  const w = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / denominator;
  const u = 1 - v - w;
  if (u < -1e-6 || v < -1e-6 || w < -1e-6) return null;
  return ay * u + by * v + cy * w;
}

function triangleAreaXZ(triangle) {
  return Math.abs(
    (triangle[3] - triangle[0]) * (triangle[8] - triangle[2]) -
      (triangle[6] - triangle[0]) * (triangle[5] - triangle[2]),
  ) / 2;
}

function distanceSquared(cell, x, z) {
  return (cell.x - x) ** 2 + (cell.z - z) ** 2;
}
