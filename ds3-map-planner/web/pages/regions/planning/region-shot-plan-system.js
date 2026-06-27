import * as THREE from "three";
import { filterTrianglesForRegion } from "../geometry/region-geometry.js";
import { cellIsInCameraFootprint, createCoverageStats } from "./region-coverage-stats.js";
import { createMergedCollisionMesh } from "./region-collision-bvh.js";

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
    this.workerReject = null;
    this.requestId = 0;
    this.ceilingRaycaster = new THREE.Raycaster();
  }

  async calculate(region, triangles, config, { signal, onProgress } = {}) {
    const normalizedConfig = normalizeRegionShotConfig(config);
    throwIfAborted(signal);
    reportProgress(onProgress, "target_geometry", 0, triangles.length);
    const clippedTriangles = filterTrianglesForRegion(triangles, region);
    if (!clippedTriangles.length) {
      throw new Error("This region contains no Stage 3 navmesh area.");
    }
    reportProgress(onProgress, "target_geometry", triangles.length, triangles.length);

    reportProgress(onProgress, "worker_candidates", 0, 1);
    const workerResult = await this.runWorker(
      flattenTriangles(clippedTriangles),
      normalizedConfig,
      signal,
    );
    reportProgress(onProgress, "worker_candidates", 1, 1);

    const planning = await this.planCandidates(workerResult, normalizedConfig, {
      signal,
      onProgress,
    });
    throwIfAborted(signal);
    reportProgress(onProgress, "coverage_summary", 0, 1);
    const plan = createRegionShotPlan({
      region,
      config: normalizedConfig,
      workerResult,
      adjustment: planning,
    });
    reportProgress(onProgress, "coverage_summary", 1, 1);
    return plan;
  }

  cancel(reason = "Calculation cancelled.") {
    this.requestId += 1;
    this.worker?.terminate();
    this.worker = null;
    this.workerReject?.(createAbortError(reason));
    this.workerReject = null;
  }

  dispose() {
    this.cancel();
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

  runWorker(triangles, config, signal) {
    this.cancel("Superseded by a new calculation.");
    const id = ++this.requestId;
    const worker = new Worker(
      new URL("../../../region-shot-plan-worker.js", import.meta.url),
      { type: "module" },
    );
    this.worker = worker;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        if (this.workerReject === rejectActive) this.workerReject = null;
        callback(value);
      };
      const rejectActive = (error) => finish(reject, error);
      const onAbort = () => rejectActive(createAbortError());
      this.workerReject = rejectActive;
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.addEventListener("message", ({ data }) => {
        if (data.id !== id) return;
        if (data.ok) finish(resolve, data.result);
        else finish(reject, new Error(data.error));
      });
      worker.addEventListener("error", (event) =>
        finish(reject, new Error(event.message || "Shot-plan worker failed.")),
      );
      worker.postMessage({ id, triangleData: triangles.buffer, config }, [
        triangles.buffer,
      ]);
      if (signal?.aborted) onAbort();
    });
  }

  async planCandidates(workerResult, config, { signal, onProgress }) {
    const targetCells = workerResult.target_cells;
    const coveredKeys = new Set();
    const uncoverableKeys = new Set();
    const accepted = [];
    const rejectedByReason = createRejectCounts();
    let lowered = 0;
    let attempted = 0;

    for (let index = 0; index < workerResult.points.length; index += 1) {
      throwIfAborted(signal);
      const result = this.evaluateCandidate(workerResult.points[index], targetCells, config);
      attempted += 1;
      if (result.accepted) {
        accepted.push(result.point);
        if (result.point.lowered) lowered += 1;
        addAll(coveredKeys, result.coveredKeys);
      } else {
        rejectedByReason[result.reason] += 1;
      }
      reportProgress(onProgress, "initial_raycast", index + 1, workerResult.points.length);
      if ((index + 1) % MAIN_THREAD_YIELD_BATCH === 0) await yieldToMainThread();
    }

    const localByKey = new Map(
      workerResult.local_candidates.map((candidate) => [
        workerResult.target_cells[candidate.id]?.key,
        candidate,
      ]),
    );
    const attemptedLocalKeys = new Set();
    const maxLocalAttempts = Math.min(
      targetCells.length,
      Math.max(64, Math.ceil(targetCells.length * 0.5)),
    );
    let localAttempts = 0;
    let replenished = 0;

    while (localAttempts < maxLocalAttempts) {
      throwIfAborted(signal);
      const uncovered = targetCells.filter(
        (cell) => !coveredKeys.has(cell.key) && !uncoverableKeys.has(cell.key),
      );
      if (!uncovered.length) break;
      const components = connectedTargetComponents(uncovered);
      const component = components[0];
      const candidateCells = component
        .filter((cell) => !attemptedLocalKeys.has(cell.key) && localByKey.has(cell.key))
        .sort((a, b) => distanceToComponentCenter(a, component) - distanceToComponentCenter(b, component));

      if (!candidateCells.length) {
        addAll(uncoverableKeys, component.map((cell) => cell.key));
        continue;
      }

      const candidateCell = candidateCells[0];
      attemptedLocalKeys.add(candidateCell.key);
      const result = this.evaluateCandidate(localByKey.get(candidateCell.key), targetCells, config);
      attempted += 1;
      localAttempts += 1;
      if (result.accepted) {
        result.point.replenished = true;
        accepted.push(result.point);
        replenished += 1;
        if (result.point.lowered) lowered += 1;
        addAll(coveredKeys, result.coveredKeys);
      } else {
        rejectedByReason[result.reason] += 1;
      }
      reportProgress(onProgress, "local_replenishment", localAttempts, maxLocalAttempts);
      if (localAttempts % MAIN_THREAD_YIELD_BATCH === 0) await yieldToMainThread();
    }

    const unresolved = targetCells.filter(
      (cell) => !coveredKeys.has(cell.key) && !uncoverableKeys.has(cell.key),
    );
    for (const component of connectedTargetComponents(unresolved)) {
      const exhausted = component.every(
        (cell) => !localByKey.has(cell.key) || attemptedLocalKeys.has(cell.key),
      );
      if (exhausted) addAll(uncoverableKeys, component.map((cell) => cell.key));
    }
    const remainingKeys = targetCells
      .filter(
        (cell) => !coveredKeys.has(cell.key) && !uncoverableKeys.has(cell.key),
      )
      .map((cell) => cell.key);
    return {
      points: accepted,
      target_cells: targetCells,
      covered_cell_keys: [...coveredKeys],
      uncoverable_cell_keys: [...uncoverableKeys],
      remaining_cell_keys: remainingKeys,
      lowered,
      attempted,
      rejected_by_reason: rejectedByReason,
      replenished_count: replenished,
    };
  }

  evaluateCandidate(candidate, targetCells, config) {
    const hit = this.findCeilingHit(candidate);
    let point = { ...candidate, lowered: false, replenished: Boolean(candidate.replenished) };
    if (hit?.point) {
      const adjustedY = hit.point.y - CEILING_CLEARANCE;
      if (adjustedY <= candidate.y_ref + MIN_CAMERA_CLEARANCE_ABOVE_NAV) {
        return { accepted: false, reason: "clearance" };
      }
      point = { ...point, y: adjustedY, lowered: true };
    }

    const footprintCells = targetCells.filter((cell) =>
      cellIsInCameraFootprint(cell, point, config),
    );
    if (!footprintCells.length) {
      return { accepted: false, reason: "no_coverage" };
    }
    if (footprintCells.some((cell) => !this.sampleCanSeeCamera(cell, point))) {
      return { accepted: false, reason: "occlusion" };
    }
    return {
      accepted: true,
      point,
      coveredKeys: footprintCells.map((cell) => cell.key),
    };
  }

  findCeilingHit(point) {
    this.ceilingRaycaster.set(
      new THREE.Vector3(point.x, point.y_ref + 0.05, point.z),
      new THREE.Vector3(0, 1, 0),
    );
    this.ceilingRaycaster.far = Math.max(0, point.y - point.y_ref - 0.1);
    return this.intersectCollision()[0];
  }

  sampleCanSeeCamera(sample, camera) {
    const from = new THREE.Vector3(sample.x, sample.y_ref + 0.05, sample.z);
    const to = new THREE.Vector3(camera.x, camera.y, camera.z);
    const delta = to.clone().sub(from);
    const distance = delta.length();
    if (distance <= 1e-5) return true;
    this.ceilingRaycaster.set(from, delta.multiplyScalar(1 / distance));
    this.ceilingRaycaster.far = Math.max(0, distance - 0.1);
    return !this.intersectCollision()[0];
  }

  intersectCollision() {
    return this.raycastCollisionMesh
      ? this.ceilingRaycaster.intersectObject(this.raycastCollisionMesh, false)
      : this.ceilingRaycaster.intersectObjects(this.getCollisionTargets(), true);
  }
}

export function normalizeRegionShotConfig(config = {}) {
  return {
    ...DEFAULT_REGION_SHOT_CONFIG,
    ...config,
    render_width: clampInteger(config.render_width, 64, 16384, DEFAULT_REGION_SHOT_CONFIG.render_width),
    render_height: clampInteger(config.render_height, 64, 16384, DEFAULT_REGION_SHOT_CONFIG.render_height),
    fov_y_rad: clampNumber(config.fov_y_rad, Math.PI / 18, Math.PI * 17 / 18, DEFAULT_REGION_SHOT_CONFIG.fov_y_rad),
    base_ratio_px_per_wu: clampNumber(config.base_ratio_px_per_wu, 1, 4096, DEFAULT_REGION_SHOT_CONFIG.base_ratio_px_per_wu),
    density_multiplier: clampNumber(config.density_multiplier, 0.1, 10, DEFAULT_REGION_SHOT_CONFIG.density_multiplier),
    overlap_ratio: clampNumber(config.overlap_ratio, 0, 0.9, DEFAULT_REGION_SHOT_CONFIG.overlap_ratio),
    y_lift: clampNumber(config.y_lift, 0, 100, DEFAULT_REGION_SHOT_CONFIG.y_lift),
  };
}

export function createRegionShotPlan({ region, config, workerResult, adjustment }) {
  const {
    target_cells: _targetCells,
    local_candidates: _localCandidates,
    ...planMetadata
  } = workerResult;
  return {
    region_name: region.name,
    config: { ...config },
    plan: {
      ...planMetadata,
      points: adjustment.points,
    },
    coverage: createCoverageStats({
      targetCells: adjustment.target_cells,
      workerResult,
      adjustment,
    }),
  };
}

export function flattenTriangles(triangles) {
  return new Float32Array(triangles.flat(2));
}

export function connectedTargetComponents(cells) {
  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  const visited = new Set();
  const components = [];
  for (const cell of cells) {
    if (visited.has(cell.key)) continue;
    const queue = [cell];
    const component = [];
    visited.add(cell.key);
    while (queue.length) {
      const current = queue.pop();
      component.push(current);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx === 0 && dz === 0) continue;
          for (let dl = -1; dl <= 1; dl += 1) {
            const neighbor = byKey.get(`${current.ix + dx}:${current.iz + dz}:${current.layer + dl}`);
            if (!neighbor || visited.has(neighbor.key)) continue;
            if (Math.abs(neighbor.y_ref - current.y_ref) > 0.75) continue;
            visited.add(neighbor.key);
            queue.push(neighbor);
          }
        }
      }
    }
    components.push(component);
  }
  return components.sort((a, b) => componentArea(b) - componentArea(a));
}

function distanceToComponentCenter(cell, component) {
  const area = componentArea(component) || 1;
  const x = component.reduce((sum, item) => sum + item.x * item.area, 0) / area;
  const z = component.reduce((sum, item) => sum + item.z * item.area, 0) / area;
  return (cell.x - x) ** 2 + (cell.z - z) ** 2;
}

function componentArea(component) {
  return component.reduce((sum, cell) => sum + cell.area, 0);
}

function createRejectCounts() {
  return { clearance: 0, occlusion: 0, no_coverage: 0 };
}

function addAll(target, values) {
  for (const value of values) target.add(value);
}

function reportProgress(callback, phase, processed, total) {
  callback?.({ phase, processed, total, ratio: total ? processed / total : 1 });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(message = "Calculation cancelled.") {
  return new DOMException(message, "AbortError");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function yieldToMainThread() {
  if (typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
