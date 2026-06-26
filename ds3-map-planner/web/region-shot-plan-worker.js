// Candidate generation is intentionally worker-only. Collision/BVH raycasts stay
// on the main thread because Three.js BVHs are not transferable.
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

export function calculateRegionShotCandidates(triangleData, config) {
  const values = new Float32Array(triangleData);
  const triangles = [];
  const bounds = createEmptyBounds();

  for (let i = 0; i + 8 < values.length; i += 9) {
    const triangle = values.subarray(i, i + 9);
    triangles.push(triangle);
    expandBounds(bounds, triangle);
  }
  if (triangles.length === 0) {
    throw new Error("selected nav segments contain no triangles");
  }

  const metrics = createCoverageMetrics(config);
  const cells = buildSpatialCells(triangles, bounds, metrics.cellSize);
  const { points, candidatePoints } = sampleCameraCandidates({
    triangles,
    bounds,
    cells,
    metrics,
    config,
  });

  return createShotCandidateResult({
    config,
    metrics,
    points,
    triangleCount: triangles.length,
    candidatePoints,
    spatialCells: cells.size,
  });
}

function barycentricHeight(x, z, tri) {
  const ax = tri[0];
  const ay = tri[1];
  const az = tri[2];
  const bx = tri[3];
  const by = tri[4];
  const bz = tri[5];
  const cx = tri[6];
  const cy = tri[7];
  const cz = tri[8];
  const v0x = bx - ax;
  const v0z = bz - az;
  const v1x = cx - ax;
  const v1z = cz - az;
  const v2x = x - ax;
  const v2z = z - az;
  const den = v0x * v1z - v1x * v0z;
  if (Math.abs(den) <= 1e-8) return null;

  const v = (v2x * v1z - v1x * v2z) / den;
  const w = (v0x * v2z - v2x * v0z) / den;
  const u = 1 - v - w;
  if (u < -1e-5 || v < -1e-5 || w < -1e-5) return null;
  return ay * u + by * v + cy * w;
}

function createEmptyBounds() {
  return {
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
}

function expandBounds(bounds, triangle) {
  for (let vertex = 0; vertex < 3; vertex++) {
    const x = triangle[vertex * 3];
    const z = triangle[vertex * 3 + 2];
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxZ = Math.max(bounds.maxZ, z);
  }
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
    cellSize: Math.max(stepX, stepZ, 1),
  };
}

function buildSpatialCells(triangles, bounds, cellSize) {
  const cells = new Map();
  for (let index = 0; index < triangles.length; index++) {
    const triangle = triangles[index];
    const tMinX = Math.min(triangle[0], triangle[3], triangle[6]);
    const tMaxX = Math.max(triangle[0], triangle[3], triangle[6]);
    const tMinZ = Math.min(triangle[2], triangle[5], triangle[8]);
    const tMaxZ = Math.max(triangle[2], triangle[5], triangle[8]);
    const ix0 = Math.floor((tMinX - bounds.minX) / cellSize);
    const ix1 = Math.floor((tMaxX - bounds.minX) / cellSize);
    const iz0 = Math.floor((tMinZ - bounds.minZ) / cellSize);
    const iz1 = Math.floor((tMaxZ - bounds.minZ) / cellSize);

    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const key = cellKey(ix, iz);
        const bucket = cells.get(key) || [];
        bucket.push(index);
        cells.set(key, bucket);
      }
    }
  }
  return cells;
}

function sampleCameraCandidates({
  triangles,
  bounds,
  cells,
  metrics,
  config,
}) {
  const points = [];
  let candidatePoints = 0;

  for (
    let z = bounds.minZ;
    z <= bounds.maxZ + 1e-5;
    z += metrics.stepZ
  ) {
    for (
      let x = bounds.minX;
      x <= bounds.maxX + 1e-5;
      x += metrics.stepX
    ) {
      candidatePoints += 1;
      const bucket = cells.get(candidateCellKey(x, z, bounds, metrics)) || [];
      const hit = highestNavHit(x, z, bucket, triangles);
      if (!hit) continue;
      points.push({
        id: points.length,
        x,
        y: hit.yRef + metrics.cameraHeight + config.y_lift,
        z,
        y_ref: hit.yRef,
        nav_hit_count: hit.count,
      });
    }
  }

  return { points, candidatePoints };
}

function highestNavHit(x, z, bucket, triangles) {
  let yRef = -Infinity;
  let count = 0;
  for (const triIndex of bucket) {
    const y = barycentricHeight(x, z, triangles[triIndex]);
    if (y === null) continue;
    count += 1;
    yRef = Math.max(yRef, y);
  }
  return count ? { yRef, count } : null;
}

function candidateCellKey(x, z, bounds, metrics) {
  return cellKey(
    Math.floor((x - bounds.minX) / metrics.cellSize),
    Math.floor((z - bounds.minZ) / metrics.cellSize),
  );
}

function cellKey(ix, iz) {
  return `${ix}:${iz}`;
}

function createShotCandidateResult({
  config,
  metrics,
  points,
  triangleCount,
  candidatePoints,
  spatialCells,
}) {
  return {
    coord_space: "world",
    version: 1,
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
    wait_load_ms: config.wait_load_ms,
    wait_shot_ms: config.wait_shot_ms,
    camera: {
      direction: [0, -1, 0],
      up: [0, 0, -1],
      near: 0.1,
      far: Math.max(1000, metrics.cameraHeight * 2),
    },
    points,
    stats: {
      triangles: triangleCount,
      candidate_points: candidatePoints,
      accepted_points: points.length,
      spatial_cells: spatialCells,
    },
  };
}
