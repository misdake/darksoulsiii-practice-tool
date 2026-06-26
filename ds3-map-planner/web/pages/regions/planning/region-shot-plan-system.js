import * as THREE from "three";
import {
  cameraHeightFromConfig,
  collectCoverageSamples,
  createCoverageStats,
  isSampleCovered,
} from "./region-coverage-stats.js";
import { createMergedCollisionMesh } from "./region-collision-bvh.js";
import {
  footprintForHeight,
} from "../geometry/region-coverage-geometry.js";
import {
  createSampleSpatialIndex,
  querySampleSpatialIndex,
} from "./region-sample-spatial-index.js";

export const DEFAULT_REGION_SHOT_CONFIG = Object.freeze({
  render_width: 2560,
  render_height: 1440,
  fov_y_rad: 0.75049156,
  base_ratio_px_per_wu: 256,
  density_multiplier: 1,
  overlap_ratio: 0.15,
  y_lift: 2,
  wait_load_ms: 0,
  wait_shot_ms: 0,
});

const CEILING_CLEARANCE = 0.2;
const MIN_CAMERA_CLEARANCE_ABOVE_NAV = 0.25;
const MAIN_THREAD_YIELD_BATCH = 32;

export class RegionShotPlanSystem {
  constructor({ getCollisionTargets }) {
    this.getCollisionTargets = getCollisionTargets;
    this.raycastCollisionMesh = null;
    this.worker = null;
    this.requestId = 0;
    this.ceilingRaycaster = new THREE.Raycaster();
  }

  async calculate(region, triangles) {
    const config = { ...DEFAULT_REGION_SHOT_CONFIG };
    const workerResult = await this.runWorker(flattenTriangles(triangles), config);
    const adjustment = await this.lowerCeilingBlockedCameras(
      workerResult.points,
      triangles,
      config,
    );
    const replenished = await this.replenishUncoveredCameras(
      triangles,
      adjustment.points,
      config,
    );

    return createRegionShotPlan({
      region,
      config,
      triangles,
      workerResult,
      adjustment: {
        ...adjustment,
        points: replenished.points,
        replenished_count: replenished.replenished,
      },
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.disposeCollisionMesh();
  }

  rebuildCollisionBvh(collisionGroup) {
    this.disposeCollisionMesh();
    this.raycastCollisionMesh = createMergedCollisionMesh(collisionGroup);
  }

  disposeCollisionMesh() {
    this.raycastCollisionMesh?.geometry?.disposeBoundsTree?.();
    this.raycastCollisionMesh?.geometry?.dispose?.();
    this.raycastCollisionMesh?.material?.dispose?.();
    this.raycastCollisionMesh = null;
  }

  runWorker(triangles, config) {
    if (!this.worker) {
      this.worker = new Worker(
        new URL("../../../region-shot-plan-worker.js", import.meta.url),
        { type: "module" },
      );
    }

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const onMessage = ({ data }) => {
        if (data.id !== id) {
          return;
        }

        this.worker.removeEventListener("message", onMessage);
        if (data.ok) {
          resolve(data.result);
        } else {
          reject(new Error(data.error));
        }
      };

      this.worker.addEventListener("message", onMessage);
      this.worker.postMessage({ id, triangleData: triangles.buffer, config }, [
        triangles.buffer,
      ]);
    });
  }

  async lowerCeilingBlockedCameras(points, triangles, config) {
    let lowered = 0;
    let rejected = 0;
    const accepted = [];
    const samples = collectCoverageSamples(triangles);
    const sampleIndex = createSampleSpatialIndex(samples);

    for (let index = 0; index < points.length; index += 1) {
      const adjusted = this.adjustCameraForCeiling(points[index], sampleIndex, config);
      if (!adjusted) {
        rejected += 1;
      } else {
        if (adjusted.lowered) {
          lowered += 1;
        }
        accepted.push(adjusted.point);
      }

      if (index % MAIN_THREAD_YIELD_BATCH === MAIN_THREAD_YIELD_BATCH - 1) {
        await yieldToMainThread();
      }
    }

    return { points: accepted, lowered, rejected };
  }

  adjustCameraForCeiling(point, samples = [], config = DEFAULT_REGION_SHOT_CONFIG) {
    const hit = this.findCeilingHit(point);
    let adjustedPoint = point;
    let lowered = false;
    if (!hit?.point) {
      adjustedPoint = point;
    } else {
      const adjustedY = hit.point.y - CEILING_CLEARANCE;
      if (adjustedY <= point.y_ref + MIN_CAMERA_CLEARANCE_ABOVE_NAV) {
        return null;
      }
      adjustedPoint = { ...point, y: adjustedY };
      lowered = true;
    }

    if (!this.cameraCanSeeFootprint(adjustedPoint, samples, config)) {
      return null;
    }
    return {
      point: adjustedPoint,
      lowered,
    };
  }

  async replenishUncoveredCameras(triangles, acceptedPoints, config) {
    const points = [...acceptedPoints];
    let replenished = 0;
    const samples = collectCoverageSamples(triangles);
    const sampleIndex = createSampleSpatialIndex(samples);

    for (const sample of samples) {
      if (isSampleCovered(sample, points, config)) {
        continue;
      }

      const candidate = {
        id: points.length,
        x: sample[0],
        y_ref: sample[1],
        y: sample[1] + cameraHeightFromConfig(config) + config.y_lift,
        z: sample[2],
        nav_hit_count: 1,
        replenished: true,
      };
      const adjusted = this.adjustCameraForCeiling(candidate, sampleIndex, config);
      if (adjusted?.point) {
        points.push(adjusted.point);
        replenished += 1;
      }

      if (replenished % MAIN_THREAD_YIELD_BATCH === MAIN_THREAD_YIELD_BATCH - 1) {
        await yieldToMainThread();
      }
    }

    return { points, replenished };
  }

  findCeilingHit(point) {
    this.ceilingRaycaster.set(
      new THREE.Vector3(point.x, point.y_ref + 0.05, point.z),
      new THREE.Vector3(0, 1, 0),
    );
    this.ceilingRaycaster.far = Math.max(0, point.y - point.y_ref - 0.1);
    if (this.raycastCollisionMesh) {
      return this.ceilingRaycaster.intersectObject(
        this.raycastCollisionMesh,
        false,
      )[0];
    }
    return this.ceilingRaycaster.intersectObjects(this.getCollisionTargets(), true)[0];
  }

  cameraCanSeeFootprint(camera, sampleIndex, config) {
    const footprint = footprintForHeight(
      config,
      Math.max(0, camera.y - camera.y_ref),
    );
    const footprintSamples = querySampleSpatialIndex(sampleIndex, camera, footprint);
    return footprintSamples.every((sample) =>
      this.sampleCanSeeCamera(sample, camera),
    );
  }

  sampleCanSeeCamera(sample, camera) {
    const from = new THREE.Vector3(sample[0], sample[1] + 0.05, sample[2]);
    const to = new THREE.Vector3(camera.x, camera.y, camera.z);
    const delta = to.clone().sub(from);
    const distance = delta.length();
    if (distance <= 1e-5) {
      return true;
    }

    this.ceilingRaycaster.set(from, delta.multiplyScalar(1 / distance));
    this.ceilingRaycaster.far = Math.max(0, distance - 0.1);
    const hit = this.raycastCollisionMesh
      ? this.ceilingRaycaster.intersectObject(this.raycastCollisionMesh, false)[0]
      : this.ceilingRaycaster.intersectObjects(this.getCollisionTargets(), true)[0];
    return !hit;
  }
}

export function createRegionShotPlan({
  region,
  config,
  triangles,
  workerResult,
  adjustment,
}) {
  return {
    region_name: region.name,
    config: { ...config },
    plan: {
      ...workerResult,
      points: adjustment.points,
    },
    coverage: createCoverageStats({
      triangles,
      workerResult,
      adjustment,
    }),
  };
}

export function flattenTriangles(triangles) {
  return new Float32Array(triangles.flat(2));
}

function yieldToMainThread() {
  if (typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
