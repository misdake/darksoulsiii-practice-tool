import * as THREE from "three";
import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js";
import { computeGeometryBoundsTree } from "../bvh.js";

const PLAYER_RADIUS = 0.30;
const PLAYER_SEGMENT = 0.96;

export class PhysicsSystem {
  constructor() {
    this.active = false;
    this.initialized = false;
    this.rapier = null;
    this.world = null;
    this.characterController = null;
    this.playerBody = null;
    this.playerCollider = null;
    this.worldBodies = [];
    this.worldColliders = [];
    this.playerDebugMesh = null;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    await RAPIER.init({});
    this.rapier = RAPIER;
    this.world = new this.rapier.World({ x: 0, y: -24, z: 0 });
    this.initialized = true;
  }

  clearWorld() {
    if (!this.world) return;
    for (const c of this.worldColliders) this.world.removeCollider(c, false);
    for (const b of this.worldBodies) this.world.removeRigidBody(b);
    this.worldBodies = [];
    this.worldColliders = [];
  }

  addTrimeshColliderFromMesh(mesh) {
    if (!this.world || !mesh.geometry) return;
    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    if (!pos || pos.count === 0) return;
    const worldMat = mesh.matrixWorld;
    const vertices = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(worldMat);
      vertices[i * 3 + 0] = v.x;
      vertices[i * 3 + 1] = v.y;
      vertices[i * 3 + 2] = v.z;
    }
    let indices;
    if (geom.index) {
      const src = geom.index.array;
      indices = new Uint32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        indices[i + 0] = src[i + 0];
        indices[i + 1] = src[i + 2];
        indices[i + 2] = src[i + 1];
      }
    } else {
      const triCount = Math.floor(pos.count / 3);
      indices = new Uint32Array(triCount * 3);
      for (let i = 0; i < triCount; i++) {
        const b = i * 3;
        indices[b + 0] = b + 0;
        indices[b + 1] = b + 2;
        indices[b + 2] = b + 1;
      }
    }
    const rb = this.world.createRigidBody(this.rapier.RigidBodyDesc.fixed());
    const cd = this.rapier.ColliderDesc.trimesh(vertices, indices);
    const co = this.world.createCollider(cd, rb);
    this.worldBodies.push(rb);
    this.worldColliders.push(co);
  }

  rebuildFromCollision(ctx) {
    if (!this.world || !ctx.collisionGroup) return;
    this.clearWorld();
    ctx.collisionGroup.updateMatrixWorld(true);
    const isHierarchyVisible = (obj) => {
      let cur = obj;
      while (cur) {
        if (cur.visible === false) return false;
        cur = cur.parent;
      }
      return true;
    };
    ctx.collisionGroup.traverse((obj) => {
      if (!obj.isMesh) return;
      if (!isHierarchyVisible(obj)) return;
      this.addTrimeshColliderFromMesh(obj);
    });
  }

  ensurePlayerBody(ctx) {
    if (!this.world || this.playerBody) return;
    this.playerBody = this.world.createRigidBody(this.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 3, 0));
    const cd = this.rapier.ColliderDesc.capsule(PLAYER_SEGMENT * 0.5, PLAYER_RADIUS).setFriction(0.0).setRestitution(0.0);
    this.playerCollider = this.world.createCollider(cd, this.playerBody);
    this.characterController = this.world.createCharacterController(0.008);
    this.characterController.setMaxSlopeClimbAngle((56 * Math.PI) / 180);
    this.characterController.setMinSlopeSlideAngle((64 * Math.PI) / 180);
    if (typeof this.characterController.enableAutostep === "function") {
      this.characterController.enableAutostep(0.42, 0.24, true);
    }
    if (!this.playerDebugMesh) {
      this.playerDebugMesh = new THREE.Mesh(
        computeGeometryBoundsTree(new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_SEGMENT, 8, 16)),
        new THREE.MeshStandardMaterial({ color: 0x87f5b1, transparent: true, opacity: 0.6 })
      );
      this.playerDebugMesh.visible = false;
      ctx.scene.add(this.playerDebugMesh);
    }
  }

  enter(ctx) {
    this.active = true;
    this.ensureInitialized()
      .then(() => {
        this.rebuildFromCollision(ctx);
        this.ensurePlayerBody(ctx);
      })
      .catch((e) => ctx.setStatus?.(`rapier init failed: ${e.message || e}`, true));
  }

  exit(_ctx) {
    this.active = false;
    if (this.playerDebugMesh) this.playerDebugMesh.visible = false;
  }

  update(ctx, dt) {
    if (!this.active) return;
    if (!this.world || !this.playerBody || !this.characterController || !this.playerCollider) return;
    const s = ctx.runtime.physicsState;
    const requested = {
      x: s.requestedMove.x,
      y: s.verticalVelocity * dt,
      z: s.requestedMove.z,
    };
    this.characterController.computeColliderMovement(this.playerCollider, requested);
    const corrected = this.characterController.computedMovement();
    const p = this.playerBody.translation();
    const next = { x: p.x + corrected.x, y: p.y + corrected.y, z: p.z + corrected.z };
    this.playerBody.setNextKinematicTranslation(next);
    s.grounded = this.characterController.computedGrounded();
    if (s.grounded && s.verticalVelocity < 0) s.verticalVelocity = 0;
    this.world.step();
    const np = this.playerBody.translation();
    s.position.set(np.x, np.y, np.z);
    if (this.playerDebugMesh) {
      this.playerDebugMesh.visible = true;
      this.playerDebugMesh.position.copy(s.position);
    }
  }

  setPlayerPosition(ctx, pos) {
    if (!this.playerBody || !pos) return;
    const next = { x: Number(pos.x) || 0, y: Number(pos.y) || 0, z: Number(pos.z) || 0 };
    this.playerBody.setNextKinematicTranslation(next);
    this.playerBody.setTranslation(next, true);
    if (ctx?.runtime?.physicsState?.position) {
      ctx.runtime.physicsState.position.set(next.x, next.y, next.z);
      ctx.runtime.physicsState.verticalVelocity = 0;
      ctx.runtime.physicsState.grounded = false;
    }
    if (this.playerDebugMesh) this.playerDebugMesh.position.set(next.x, next.y, next.z);
  }
}
