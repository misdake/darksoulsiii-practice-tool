const SAMPLE_INDEX_CELL_SIZE = 4;

export function createSampleSpatialIndex(samples, cellSize = SAMPLE_INDEX_CELL_SIZE) {
  const cells = new Map();
  for (const sample of samples) {
    const key = sampleCellKey(sample[0], sample[2], cellSize);
    const bucket = cells.get(key) || [];
    bucket.push(sample);
    cells.set(key, bucket);
  }
  return { cells, cellSize };
}

export function querySampleSpatialIndex(index, camera, footprint) {
  if (Array.isArray(index)) {
    return index;
  }
  const halfX = footprint.width / 2;
  const halfZ = footprint.height / 2;
  const minX = Math.floor((camera.x - halfX) / index.cellSize);
  const maxX = Math.floor((camera.x + halfX) / index.cellSize);
  const minZ = Math.floor((camera.z - halfZ) / index.cellSize);
  const maxZ = Math.floor((camera.z + halfZ) / index.cellSize);
  const samples = [];
  for (let ix = minX; ix <= maxX; ix += 1) {
    for (let iz = minZ; iz <= maxZ; iz += 1) {
      for (const sample of index.cells.get(`${ix}:${iz}`) || []) {
        if (
          Math.abs(sample[0] - camera.x) <= halfX &&
          Math.abs(sample[2] - camera.z) <= halfZ
        ) {
          samples.push(sample);
        }
      }
    }
  }
  return samples;
}

function sampleCellKey(x, z, cellSize) {
  return `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
}
