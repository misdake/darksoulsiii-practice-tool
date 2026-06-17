import * as THREE from "three";

const DEFAULT_CONFIG = Object.freeze({
  render_width: 2560,
  render_height: 1440,
  fov_y_rad: 0.75049156,
  base_ratio_px_per_wu: 32,
  density_multiplier: 2,
  overlap_ratio: 0.5,
  y_lift: 2,
  wait_load_ms: 500,
  wait_shot_ms: 1000,
});
const CAMERA_MOVE_SPEED = 12;

export class ShotPlanSystem {
  constructor(elements) {
    this.elements = elements;
    this.active = false;
    this.result = null;
    this.selectedIndex = -1;
    this.worker = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.group = new THREE.Group();
    this.group.name = "shot-plan-visuals";
    this.markerMesh = null;
    this.frustumLines = null;
    this.selectedHelper = null;
    this.previewState = null;
    this.addMode = false;
    this.moveKeys = new Set();
    this.raycaster = new THREE.Raycaster();
    this.instanceMatrix = new THREE.Matrix4();
    this.moveForward = new THREE.Vector3();
    this.moveRight = new THREE.Vector3();
    this.moveVector = new THREE.Vector3();
    this.moveInfoElapsed = 0;
    this.bindUi();
    this.writeConfig(DEFAULT_CONFIG);
    this.renderInfo();
  }

  bindUi() {
    this.elements.calculateButton?.addEventListener("click", () => {
      if (this.lastContext) void this.calculate(this.lastContext);
    });
    this.elements.previewButton?.addEventListener("click", () => {
      if (this.lastContext) this.previewSelected(this.lastContext);
    });
    this.elements.exitPreviewButton?.addEventListener("click", () => {
      if (this.lastContext) this.exitPreview(this.lastContext);
    });
    this.elements.showFrustumsInput?.addEventListener("change", () => this.renderVisuals());
    this.elements.firstButton?.addEventListener("click", () => this.selectIndex(0));
    this.elements.previousButton?.addEventListener("click", () => this.selectRelative(-1));
    this.elements.nextButton?.addEventListener("click", () => this.selectRelative(1));
    this.elements.lastButton?.addEventListener("click", () => this.selectIndex((this.result?.points?.length || 1) - 1));
    this.elements.addModeButton?.addEventListener("click", () => this.setAddMode(!this.addMode));
    this.elements.cloneButton?.addEventListener("click", () => this.cloneSelected(this.lastContext));
    window.addEventListener("blur", () => this.moveKeys.clear());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.moveKeys.clear();
    });
  }

  enter(ctx) {
    this.active = true;
    this.lastContext = ctx;
    if (!this.group.parent) ctx.root.add(this.group);
    this.group.visible = true;
    this.renderVisuals();
    this.renderInfo();
  }

  exit(ctx) {
    this.active = false;
    this.setAddMode(false);
    this.moveKeys.clear();
    this.exitPreview(ctx);
    this.group.visible = false;
  }

  onSceneReload(ctx) {
    this.lastContext = ctx;
    if (!this.group.parent) ctx.root.add(this.group);
    this.renderVisuals();
  }

  disposeVisuals() {
    this.group.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (Array.isArray(obj.material)) obj.material.forEach((material) => material?.dispose?.());
      else obj.material?.dispose?.();
    });
    this.group.clear();
    this.markerMesh = null;
    this.frustumLines = null;
    this.selectedHelper = null;
  }

  writeFrustumVertices(vertices, offset, point) {
    const x = point.x;
    const cameraY = point.y;
    const z = -point.z;
    const groundY = point.y_ref;
    const cameraHeight = Math.max(0.001, cameraY - groundY);
    const halfHeight = Math.tan(this.result.fov_y_rad * 0.5) * cameraHeight;
    const halfWidth = halfHeight * (this.result.render_width / this.result.render_height);
    const x0 = x - halfWidth;
    const x1 = x + halfWidth;
    const z0 = z - halfHeight;
    const z1 = z + halfHeight;
    const writeSegment = (ax, ay, az, bx, by, bz) => {
      vertices[offset++] = ax;
      vertices[offset++] = ay;
      vertices[offset++] = az;
      vertices[offset++] = bx;
      vertices[offset++] = by;
      vertices[offset++] = bz;
    };
    writeSegment(x, cameraY, z, x0, groundY, z0);
    writeSegment(x, cameraY, z, x1, groundY, z0);
    writeSegment(x, cameraY, z, x1, groundY, z1);
    writeSegment(x, cameraY, z, x0, groundY, z1);
    writeSegment(x0, groundY, z0, x1, groundY, z0);
    writeSegment(x1, groundY, z0, x1, groundY, z1);
    writeSegment(x1, groundY, z1, x0, groundY, z1);
    writeSegment(x0, groundY, z1, x0, groundY, z0);
  }

  createFrustumLines(points, color, opacity = 1) {
    const vertices = new Float32Array(points.length * 48);
    points.forEach((point, index) => this.writeFrustumVertices(vertices, index * 48, point));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    return new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }),
    );
  }

  readConfig() {
    const number = (key) => Number(this.elements.inputs[key]?.value);
    return {
      render_width: Math.max(1, Math.round(number("render_width") || DEFAULT_CONFIG.render_width)),
      render_height: Math.max(1, Math.round(number("render_height") || DEFAULT_CONFIG.render_height)),
      fov_y_rad: Math.max(0.01, number("fov_y_rad") || DEFAULT_CONFIG.fov_y_rad),
      base_ratio_px_per_wu: Math.max(1e-6, number("base_ratio_px_per_wu") || DEFAULT_CONFIG.base_ratio_px_per_wu),
      density_multiplier: Math.max(1e-6, number("density_multiplier") || DEFAULT_CONFIG.density_multiplier),
      overlap_ratio: Math.max(0, Math.min(0.95, number("overlap_ratio") || 0)),
      y_lift: number("y_lift") || 0,
      wait_load_ms: Math.max(0, Math.round(number("wait_load_ms") || 0)),
      wait_shot_ms: Math.max(0, Math.round(number("wait_shot_ms") || 0)),
    };
  }

  writeConfig(config) {
    const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
    for (const [key, value] of Object.entries(cfg)) {
      if (this.elements.inputs[key]) this.elements.inputs[key].value = String(value);
    }
  }

  load(data) {
    this.result = data && Array.isArray(data.points) ? data : null;
    for (const point of this.result?.points || []) {
      delete point.target_x;
      delete point.target_y;
      delete point.target_z;
    }
    this.selectedIndex = this.result?.points?.length ? 0 : -1;
    this.writeConfig(this.result?.config || this.result || DEFAULT_CONFIG);
    this.renderVisuals();
    this.renderInfo();
  }

  getSaveData() {
    return this.result;
  }

  collectTriangles(ctx) {
    const out = [];
    for (const navObj of ctx.navmeshGroup?.children || []) {
      for (const seg of navObj.children) {
        if (!seg.isMesh || seg.userData?.kind !== "nav-segment") continue;
        const key = `${seg.userData.parentPath}::${seg.userData.segmentIndex}`;
        if (ctx.navSegmentUsageStates.get(key) !== true) continue;
        const attr = seg.geometry.getAttribute("position");
        const index = seg.geometry.index;
        const count = index ? index.count : attr.count;
        for (let i = 0; i + 2 < count; i += 3) {
          for (let j = 0; j < 3; j++) {
            const vertexIndex = index ? index.getX(i + j) : i + j;
            out.push(attr.getX(vertexIndex), attr.getY(vertexIndex), attr.getZ(vertexIndex));
          }
        }
      }
    }
    return new Float32Array(out);
  }

  ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL("../shot-plan-worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => {
      const msg = event.data;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error || "shot plan worker failed"));
    };
  }

  runWorker(triangles, config) {
    this.ensureWorker();
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, triangleData: triangles.buffer, config }, [triangles.buffer]);
    });
  }

  async calculate(ctx) {
    const triangles = this.collectTriangles(ctx);
    if (triangles.length === 0) {
      ctx.setStatus("Stage 4 requires nav segments selected in Stage 3.", true);
      return;
    }
    const config = this.readConfig();
    this.elements.calculateButton.disabled = true;
    ctx.setStatus(`calculating shot plan from ${triangles.length / 9} triangles ...`);
    try {
      this.result = await this.runWorker(triangles, config);
      this.selectedIndex = this.result.points.length ? 0 : -1;
      this.renderVisuals();
      this.renderInfo();
      ctx.setStatus(`shot plan calculated: ${this.result.points.length} cameras`, false, 2200);
    } catch (error) {
      ctx.setStatus(`shot plan failed: ${error.message || error}`, true);
    } finally {
      this.elements.calculateButton.disabled = false;
    }
  }

  renderVisuals() {
    this.disposeVisuals();
    if (!this.result?.points?.length) return;
    const geometry = new THREE.SphereGeometry(0.65, 10, 8);
    const material = new THREE.MeshBasicMaterial({ color: 0x22d3ee });
    const mesh = new THREE.InstancedMesh(geometry, material, this.result.points.length);
    const matrix = new THREE.Matrix4();
    this.result.points.forEach((point, index) => {
      matrix.makeTranslation(point.x, point.y, -point.z);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.kind = "shot-plan-markers";
    this.markerMesh = mesh;
    this.group.add(mesh);
    if (this.elements.showFrustumsInput?.checked) {
      this.frustumLines = this.createFrustumLines(this.result.points, 0x22d3ee, 0.28);
      this.group.add(this.frustumLines);
    }
    if (this.selectedIndex >= 0) this.renderSelectedHelper();
  }

  renderSelectedHelper() {
    if (this.selectedHelper) {
      this.group.remove(this.selectedHelper);
      this.selectedHelper.traverse((obj) => {
        obj.geometry?.dispose?.();
        obj.material?.dispose?.();
      });
    }
    const point = this.result?.points?.[this.selectedIndex];
    if (!point) return;
    const helper = new THREE.Group();
    helper.add(this.createFrustumLines([point], 0xfacc15));
    this.selectedHelper = helper;
    this.group.add(helper);
  }

  selectIndex(index) {
    const count = this.result?.points?.length || 0;
    if (count === 0) {
      this.selectedIndex = -1;
      this.renderInfo();
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(count - 1, Number(index) || 0));
    this.renderSelectedHelper();
    this.renderInfo();
    if (this.previewState && this.lastContext) this.applySelectedPreview(this.lastContext);
  }

  selectRelative(offset) {
    const count = this.result?.points?.length || 0;
    if (count === 0) return;
    const current = this.selectedIndex >= 0 ? this.selectedIndex : 0;
    this.selectIndex((current + offset + count) % count);
  }

  setAddMode(enabled) {
    this.addMode = Boolean(enabled);
    if (this.elements.addModeButton) {
      this.elements.addModeButton.textContent = `Add Camera: ${this.addMode ? "On" : "Off"}`;
      this.elements.addModeButton.classList.toggle("active", this.addMode);
    }
    if (this.lastContext) {
      this.lastContext.setStatus(this.addMode
        ? "Add Camera mode: click a selected navmesh segment."
        : "Add Camera mode disabled.", false, 1600);
    }
  }

  updatePointVisual(index) {
    const point = this.result?.points?.[index];
    if (!point) return;
    if (this.markerMesh) {
      this.instanceMatrix.makeTranslation(point.x, point.y, -point.z);
      this.markerMesh.setMatrixAt(index, this.instanceMatrix);
      this.markerMesh.instanceMatrix.needsUpdate = true;
      this.markerMesh.boundingSphere = null;
    }
    const frustumPosition = this.frustumLines?.geometry?.getAttribute("position");
    if (frustumPosition) {
      this.writeFrustumVertices(frustumPosition.array, index * 48, point);
      frustumPosition.needsUpdate = true;
      this.frustumLines.geometry.boundingSphere = null;
    }
    const selectedPosition = this.selectedHelper?.children?.[0]?.geometry?.getAttribute("position");
    if (selectedPosition) {
      this.writeFrustumVertices(selectedPosition.array, 0, point);
      selectedPosition.needsUpdate = true;
      this.selectedHelper.children[0].geometry.boundingSphere = null;
    }
  }

  update(ctx, dt) {
    if (!this.active || this.moveKeys.size === 0) return;
    const point = this.result?.points?.[this.selectedIndex];
    if (!point) return;
    const forward = this.moveForward;
    forward.set(0, 1, 0).applyQuaternion(ctx.camera.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const right = this.moveRight.set(1, 0, 0).applyQuaternion(ctx.camera.quaternion);
    right.y = 0;
    if (right.lengthSq() < 1e-8) right.crossVectors(forward, THREE.Object3D.DEFAULT_UP);
    right.normalize();
    const move = this.moveVector.set(0, 0, 0);
    if (this.moveKeys.has("KeyW")) move.add(forward);
    if (this.moveKeys.has("KeyS")) move.sub(forward);
    if (this.moveKeys.has("KeyD")) move.add(right);
    if (this.moveKeys.has("KeyA")) move.sub(right);
    if (this.moveKeys.has("Space")) move.y += 1;
    if (this.moveKeys.has("ShiftLeft") || this.moveKeys.has("ShiftRight")) move.y -= 1;
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(CAMERA_MOVE_SPEED * dt);
    const pointBefore = this.result.points[this.selectedIndex];
    pointBefore.x += move.x;
    pointBefore.y += move.y;
    pointBefore.z -= move.z;
    this.updatePointVisual(this.selectedIndex);
    if (this.previewState) this.applySelectedPreview(ctx);
    this.moveInfoElapsed += dt;
    if (this.moveInfoElapsed >= 0.1) {
      this.moveInfoElapsed = 0;
      this.renderInfo();
    }
  }

  onKeyDown(ctx, event) {
    if (event.code === "Delete") return this.deleteSelected(ctx);
    if (!["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(event.code)) return false;
    this.moveKeys.add(event.code);
    return true;
  }

  onKeyUp(_ctx, event) {
    if (!this.moveKeys.has(event.code)) return false;
    this.moveKeys.delete(event.code);
    this.moveInfoElapsed = 0;
    this.renderInfo();
    return true;
  }

  cloneSelected(ctx) {
    const point = this.result?.points?.[this.selectedIndex];
    if (!point) return false;
    const clone = { ...point };
    this.result.points.splice(this.selectedIndex + 1, 0, clone);
    this.result.points.forEach((item, index) => { item.id = index; });
    if (this.result.stats) this.result.stats.accepted_points = this.result.points.length;
    this.selectedIndex += 1;
    this.renderVisuals();
    this.renderInfo();
    ctx?.setStatus(`camera cloned; ${this.result.points.length} total`, false, 1600);
    return true;
  }

  deleteSelected(ctx) {
    const points = this.result?.points;
    if (!points?.length || this.selectedIndex < 0) return false;
    if (this.previewState && ctx) this.exitPreview(ctx);
    points.splice(this.selectedIndex, 1);
    points.forEach((point, index) => { point.id = index; });
    if (this.result.stats) this.result.stats.accepted_points = points.length;
    this.selectedIndex = points.length ? Math.min(this.selectedIndex, points.length - 1) : -1;
    this.renderVisuals();
    this.renderInfo();
    ctx?.setStatus(`camera deleted; ${points.length} remaining`, false, 1600);
    return true;
  }

  pickNavGroundPoint(ctx, event) {
    if (!ctx.navmeshGroup) return null;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(mouse, ctx.camera);
    const targets = [];
    for (const navObj of ctx.navmeshGroup.children) {
      if (navObj.userData.manualEnabled === false || navObj.visible === false) continue;
      for (const segment of navObj.children) {
        if (!segment.isMesh || segment.visible === false || segment.userData?.kind !== "nav-segment") continue;
        const key = `${segment.userData.parentPath}::${segment.userData.segmentIndex}`;
        if (ctx.navSegmentUsageStates.get(key) === true) targets.push(segment);
      }
    }
    return this.raycaster.intersectObjects(targets, false)[0]?.point || null;
  }

  addCameraAtGroundPoint(ctx, groundPoint) {
    if (!this.result) {
      ctx.setStatus("Calculate or load a shot plan before adding cameras.", true);
      return false;
    }
    const gameZ = -groundPoint.z;
    const point = {
      id: this.result.points.length,
      x: groundPoint.x,
      y: groundPoint.y + this.result.camera_height_from_y_ref + (this.result.config?.y_lift || 0),
      z: gameZ,
      y_ref: groundPoint.y,
      nav_hit_count: 1,
      manual: true,
    };
    this.result.points.push(point);
    if (this.result.stats) this.result.stats.accepted_points = this.result.points.length;
    this.selectedIndex = this.result.points.length - 1;
    this.renderVisuals();
    this.renderInfo();
    ctx.setStatus(`camera added above [${groundPoint.x.toFixed(2)}, ${groundPoint.y.toFixed(2)}, ${gameZ.toFixed(2)}]`, false, 2200);
    return true;
  }

  onPointerClick(ctx, event) {
    if (this.addMode) {
      const groundPoint = this.pickNavGroundPoint(ctx, event);
      return groundPoint ? this.addCameraAtGroundPoint(ctx, groundPoint) : false;
    }
    if (!this.active || !this.markerMesh) return false;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(mouse, ctx.camera);
    const hit = this.raycaster.intersectObject(this.markerMesh, false)[0];
    if (!hit || !Number.isInteger(hit.instanceId)) return false;
    this.selectIndex(hit.instanceId);
    return true;
  }

  applySelectedPreview(ctx) {
    const point = this.result?.points?.[this.selectedIndex];
    if (!point) return;
    ctx.camera.position.set(point.x, point.y, -point.z);
    ctx.controls.target.set(point.x, point.y_ref, -point.z);
    ctx.camera.fov = THREE.MathUtils.radToDeg(this.result.fov_y_rad);
    ctx.camera.near = this.result.camera?.near || 0.1;
    ctx.camera.far = this.result.camera?.far || 1000;
    ctx.camera.updateProjectionMatrix();
    this.elements.exitPreviewButton.style.display = "";
  }

  previewSelected(ctx) {
    const point = this.result?.points?.[this.selectedIndex];
    if (!point) return;
    if (!this.previewState) {
      this.previewState = {
        position: ctx.camera.position.clone(),
        target: ctx.controls.target.clone(),
        fov: ctx.camera.fov,
        near: ctx.camera.near,
        far: ctx.camera.far,
      };
    }
    this.applySelectedPreview(ctx);
  }

  exitPreview(ctx) {
    if (!this.previewState) return;
    ctx.camera.position.copy(this.previewState.position);
    ctx.controls.target.copy(this.previewState.target);
    ctx.camera.fov = this.previewState.fov;
    ctx.camera.near = this.previewState.near;
    ctx.camera.far = this.previewState.far;
    ctx.camera.updateProjectionMatrix();
    this.previewState = null;
    this.elements.exitPreviewButton.style.display = "none";
  }

  renderInfo() {
    const result = this.result;
    const point = result?.points?.[this.selectedIndex];
    const lines = [];
    if (result) {
      lines.push(`Cameras: ${result.points.length}`);
      lines.push(`Triangles: ${result.stats?.triangles ?? 0}`);
      lines.push(`Candidates: ${result.stats?.candidate_points ?? 0}`);
      lines.push(`FOV Y: ${result.fov_y_rad.toFixed(6)} rad (${THREE.MathUtils.radToDeg(result.fov_y_rad).toFixed(2)} deg)`);
      lines.push(`Camera height: ${result.camera_height_from_y_ref.toFixed(3)} + lift ${result.config?.y_lift ?? 0}`);
      lines.push(`Coverage: ${result.coverage_width.toFixed(3)} x ${result.coverage_height.toFixed(3)}`);
      lines.push(`Step: ${result.step_x.toFixed(3)} x ${result.step_z.toFixed(3)}`);
    }
    if (point) {
      lines.push("");
      lines.push(`Shot #${point.id}`);
      lines.push(`Position: ${point.x.toFixed(3)}, ${point.y.toFixed(3)}, ${point.z.toFixed(3)}`);
      lines.push(`Ground Y: ${point.y_ref.toFixed(3)}`);
      lines.push(`Nav hits: ${point.nav_hit_count ?? 1}`);
      lines.push("Direction: 0, -1, 0");
      lines.push("Up: 0, 0, -1");
    }
    this.elements.info.textContent = lines.length ? lines.join("\n") : "No shot plan calculated.";
    this.elements.previewButton.disabled = !point;
    if (this.elements.cloneButton) this.elements.cloneButton.disabled = !point;
    const count = result?.points?.length || 0;
    const hasSelection = this.selectedIndex >= 0 && this.selectedIndex < count;
    if (this.elements.navigationIndex) {
      this.elements.navigationIndex.textContent = hasSelection ? `${this.selectedIndex + 1}/${count}` : `0/${count}`;
    }
    if (this.elements.firstButton) this.elements.firstButton.disabled = !hasSelection || this.selectedIndex === 0;
    if (this.elements.previousButton) this.elements.previousButton.disabled = !hasSelection || count <= 1;
    if (this.elements.nextButton) this.elements.nextButton.disabled = !hasSelection || count <= 1;
    if (this.elements.lastButton) this.elements.lastButton.disabled = !hasSelection || this.selectedIndex === count - 1;
  }
}
