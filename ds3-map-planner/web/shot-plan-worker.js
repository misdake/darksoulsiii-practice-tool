function barycentricHeight(x, pz, tri) {
  const ax = tri[0];
  const ay = tri[1];
  const az = -tri[2];
  const bx = tri[3];
  const by = tri[4];
  const bz = -tri[5];
  const cx = tri[6];
  const cy = tri[7];
  const cz = -tri[8];
  const v0x = bx - ax;
  const v0z = bz - az;
  const v1x = cx - ax;
  const v1z = cz - az;
  const v2x = x - ax;
  const v2z = pz - az;
  const den = v0x * v1z - v1x * v0z;
  if (Math.abs(den) <= 1e-8) return null;
  const v = (v2x * v1z - v1x * v2z) / den;
  const w = (v0x * v2z - v2x * v0z) / den;
  const u = 1 - v - w;
  if (u < -1e-5 || v < -1e-5 || w < -1e-5) return null;
  return ay * u + by * v + cy * w;
}

export function calculateShotPlan(triangleData, config) {
  const values = new Float32Array(triangleData);
  const triangles = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minPz = Infinity;
  let maxPz = -Infinity;
  for (let i = 0; i + 8 < values.length; i += 9) {
    const tri = values.subarray(i, i + 9);
    triangles.push(tri);
    for (let v = 0; v < 3; v++) {
      const x = tri[v * 3];
      const pz = -tri[v * 3 + 2];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minPz = Math.min(minPz, pz);
      maxPz = Math.max(maxPz, pz);
    }
  }
  if (triangles.length === 0) throw new Error("selected nav segments contain no triangles");

  const density = Math.max(1e-6, config.base_ratio_px_per_wu) * Math.max(1e-6, config.density_multiplier);
  const overlap = Math.max(0, Math.min(0.95, config.overlap_ratio));
  const coverageHeight = config.render_height / density;
  const coverageWidth = config.render_width / density;
  const stepX = Math.max(0.01, coverageWidth * (1 - overlap));
  const stepZ = Math.max(0.01, coverageHeight * (1 - overlap));
  const halfFov = Math.max(1e-4, Math.min(Math.PI * 0.5 - 1e-4, config.fov_y_rad * 0.5));
  const cameraHeight = (coverageHeight * 0.5) / Math.max(1e-6, Math.tan(halfFov));

  const cellSize = Math.max(stepX, stepZ, 1);
  const cells = new Map();
  const cellKey = (ix, iz) => `${ix}:${iz}`;
  for (let index = 0; index < triangles.length; index++) {
    const t = triangles[index];
    const tMinX = Math.min(t[0], t[3], t[6]);
    const tMaxX = Math.max(t[0], t[3], t[6]);
    const tMinZ = Math.min(-t[2], -t[5], -t[8]);
    const tMaxZ = Math.max(-t[2], -t[5], -t[8]);
    const ix0 = Math.floor((tMinX - minX) / cellSize);
    const ix1 = Math.floor((tMaxX - minX) / cellSize);
    const iz0 = Math.floor((tMinZ - minPz) / cellSize);
    const iz1 = Math.floor((tMaxZ - minPz) / cellSize);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const key = cellKey(ix, iz);
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, bucket = []);
        bucket.push(index);
      }
    }
  }

  const points = [];
  let candidatePoints = 0;
  for (let pz = minPz; pz <= maxPz + 1e-5; pz += stepZ) {
    for (let x = minX; x <= maxX + 1e-5; x += stepX) {
      candidatePoints++;
      const ix = Math.floor((x - minX) / cellSize);
      const iz = Math.floor((pz - minPz) / cellSize);
      const bucket = cells.get(cellKey(ix, iz)) || [];
      let yRef = -Infinity;
      let hitCount = 0;
      for (const triIndex of bucket) {
        const y = barycentricHeight(x, pz, triangles[triIndex]);
        if (y === null) continue;
        hitCount++;
        yRef = Math.max(yRef, y);
      }
      if (hitCount === 0) continue;
      points.push({
        id: points.length,
        x,
        y: yRef + cameraHeight + config.y_lift,
        z: -pz,
        y_ref: yRef,
        nav_hit_count: hitCount,
      });
    }
  }

  return {
    coord_space: "game",
    version: 1,
    config: { ...config },
    density_px_per_wu: density,
    render_width: config.render_width,
    render_height: config.render_height,
    fov_y_rad: config.fov_y_rad,
    camera_height_from_y_ref: cameraHeight,
    coverage_width: coverageWidth,
    coverage_height: coverageHeight,
    overlap_ratio: overlap,
    step_x: stepX,
    step_z: stepZ,
    wait_load_ms: config.wait_load_ms,
    wait_shot_ms: config.wait_shot_ms,
    camera: {
      direction: [0, -1, 0],
      up: [0, 0, -1],
      near: 0.1,
      far: Math.max(1000, cameraHeight * 2),
    },
    points,
    stats: {
      triangles: triangles.length,
      candidate_points: candidatePoints,
      accepted_points: points.length,
      spatial_cells: cells.size,
    },
  };
}

if (typeof self !== "undefined") {
  self.onmessage = (event) => {
    const { id, triangleData, config } = event.data;
    try {
      self.postMessage({ id, ok: true, result: calculateShotPlan(triangleData, config) });
    } catch (error) {
      self.postMessage({ id, ok: false, error: error?.message || String(error) });
    }
  };
}
