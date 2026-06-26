import * as THREE from "three";

export function createGeometry(meshData) {
  const { positions, indices } = normalizeStaticMeshData(meshData);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

export function normalizeStaticMeshData(meshData) {
  const positions = new Float32Array(meshData.positions);
  for (let index = 2; index < positions.length; index += 3) {
    positions[index] = -positions[index];
  }
  const indices = new Uint32Array(meshData.indices);
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const swap = indices[index + 1];
    indices[index + 1] = indices[index + 2];
    indices[index + 2] = swap;
  }
  return { positions, indices };
}

export function createObjParser(workerUrl = "./obj-worker.js") {
  const worker = new Worker(workerUrl, { type: "module" });
  let nextId = 0;
  const pending = new Map();
  worker.addEventListener("message", ({ data }) => {
    const task = pending.get(data.id);
    if (!task) {
      return;
    }

    pending.delete(data.id);
    if (data.ok) {
      task.resolve(data);
    } else {
      task.reject(new Error(data.error || "OBJ parse failed"));
    }
  });
  return {
    parse(path) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, path });
      });
    },
    dispose() {
      worker.terminate();
      for (const task of pending.values()) {
        task.reject(new Error("OBJ parser disposed"));
      }
      pending.clear();
    },
  };
}

export function createObjWorkerPool(
  workerCount,
  workerUrl = "./obj-worker.js",
) {
  const parsers = Array.from({ length: Math.max(1, workerCount) }, () =>
    createObjParser(workerUrl),
  );
  let next = 0;
  return {
    parse(path) {
      const parser = parsers[next];
      next = (next + 1) % parsers.length;
      return parser.parse(path);
    },
    dispose() {
      for (const parser of parsers) {
        parser.dispose();
      }
    },
  };
}

export function disposeObjectTree(root) {
  root?.traverse?.((object) => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials.filter(Boolean)) {
      material.dispose?.();
    }
  });
  root?.clear?.();
}
