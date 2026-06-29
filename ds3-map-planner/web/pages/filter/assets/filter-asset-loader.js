import * as THREE from "three";
import { computeGeometryBoundsTree } from "../../../shared/bvh.js";
import {
  createGeometry,
  createObjWorkerPool,
  normalizeStaticMeshData,
} from "../../../shared/map-runtime.js";

export class FilterAssetLoader {
  constructor({ makeMaterial, workerCount }) {
    this.makeMaterial = makeMaterial;
    this.pool = createObjWorkerPool(workerCount);
  }

  dispose() {
    this.pool.dispose();
  }

  async loadCollision(entry) {
    const path = entry.path;
    const parsed = await this.pool.parse(path);
    const meshes = parsed.meshes || [];
    if (!meshes.length) {
      throw new Error(`empty obj: ${path}`);
    }

    const group = new THREE.Group();
    group.name = path;
    group.userData = {
      manualEnabled: true,
      kind: "collision",
      triangleCount: 0,
    };
    for (const data of meshes) {
      const geometry = createGeometry(data);
      computeGeometryBoundsTree(geometry);
      group.userData.triangleCount += Math.floor(
        (data.indices || []).length / 3,
      );
      group.add(new THREE.Mesh(geometry, this.makeMaterial("collision")));
    }
    return group;
  }

  async loadNavmesh(entry) {
    const path = entry.path;
    const parsed = await this.pool.parse(path);
    const group = new THREE.Group();
    group.name = path;
    group.userData = { manualEnabled: true, kind: "navmesh" };
    const positions = [];
    const indices = [];
    let offset = 0;

    for (const [segmentIndex, data] of (parsed.meshes || []).entries()) {
      const geometry = createGeometry(data);
      computeGeometryBoundsTree(geometry);

      const mesh = new THREE.Mesh(geometry, this.makeMaterial("navmesh"));
      mesh.userData = { kind: "nav-segment", segmentIndex, parentPath: path };
      group.add(mesh);

      const normalized = normalizeStaticMeshData(data);
      positions.push(...normalized.positions);
      for (const index of normalized.indices) {
        indices.push(index + offset);
      }
      offset += Math.floor(normalized.positions.length / 3);
    }

    if (positions.length && indices.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
      geometry.computeVertexNormals();
      computeGeometryBoundsTree(geometry);
      const merged = new THREE.Mesh(geometry, this.makeMaterial("navmesh"));
      merged.userData = { kind: "nav-merged", parentPath: path };
      merged.visible = false;
      group.add(merged);
      group.userData.mergedMesh = merged;
    }

    group.userData.segmentCount = parsed.meshes?.length || 0;
    return group;
  }

  async loadList(entries, loader, onProgress) {
    const group = new THREE.Group();
    const failed = [];
    let done = 0;

    for (const entry of entries) {
      try {
        const object = await loader.call(this, entry);
        object.userData.meta = entry;
        group.add(object);
      } catch {
        failed.push(entry.path);
      } finally {
        done += 1;
        onProgress?.(done, entries.length);
      }
    }
    return { group, failed };
  }
}
