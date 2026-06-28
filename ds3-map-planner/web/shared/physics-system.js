import * as THREE from "three";
import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js";
import { computeGeometryBoundsTree } from "./bvh.js";

const PLAYER_RADIUS = 0.3;
const PLAYER_SEGMENT = 0.96;
export const PLAYER_CAPSULE_FOOT_OFFSET =
  PLAYER_SEGMENT * 0.5 + PLAYER_RADIUS;

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
    this.activationId = 0;
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
    for (const collider of this.worldColliders) {
      this.world.removeCollider(collider, false);
    }
    for (const body of this.worldBodies) {
      this.world.removeRigidBody(body);
    }
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
    const vertex = new THREE.Vector3();
    for (let index = 0; index < pos.count; index += 1) {
      vertex
        .set(pos.getX(index), pos.getY(index), pos.getZ(index))
        .applyMatrix4(worldMat);
      vertices[index * 3 + 0] = vertex.x;
      vertices[index * 3 + 1] = vertex.y;
      vertices[index * 3 + 2] = vertex.z;
    }

    let indices;
    if (geom.index) {
      const src = geom.index.array;
      indices = new Uint32Array(src.length);
      for (let index = 0; index < src.length; index += 3) {
        indices[index + 0] = src[index + 0];
        indices[index + 1] = src[index + 2];
        indices[index + 2] = src[index + 1];
      }
    } else {
      const triCount = Math.floor(pos.count / 3);
      indices = new Uint32Array(triCount * 3);
      for (let index = 0; index < triCount; index += 1) {
        const base = index * 3;
        indices[base + 0] = base + 0;
        indices[base + 1] = base + 2;
        indices[base + 2] = base + 1;
      }
    }

    const body = this.world.createRigidBody(this.rapier.RigidBodyDesc.fixed());
    const collider = this.world.createCollider(
      this.rapier.ColliderDesc.trimesh(vertices, indices),
      body,
    );
    this.worldBodies.push(body);
    this.worldColliders.push(collider);
  }

  rebuildFromCollision(ctx) {
    if (!this.world || !ctx.collisionGroup) return;
    this.clearWorld();
    ctx.collisionGroup.updateMatrixWorld(true);
    ctx.collisionGroup.traverse((object) => {
      if (!object.isMesh || !isHierarchyPhysicsEnabled(object)) return;
      this.addTrimeshColliderFromMesh(object);
    });
  }

  ensurePlayerBody(ctx) {
    if (!this.world || this.playerBody) return;
    this.playerBody = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        0,
        3,
        0,
      ),
    );
    this.playerCollider = this.world.createCollider(
      this.rapier.ColliderDesc.capsule(PLAYER_SEGMENT * 0.5, PLAYER_RADIUS)
        .setFriction(0)
        .setRestitution(0),
      this.playerBody,
    );
    this.characterController = this.world.createCharacterController(0.008);
    this.characterController.setMaxSlopeClimbAngle((56 * Math.PI) / 180);
    this.characterController.setMinSlopeSlideAngle((64 * Math.PI) / 180);
    if (typeof this.characterController.enableAutostep === "function") {
      this.characterController.enableAutostep(0.42, 0.24, true);
    }

    if (!this.playerDebugMesh) {
      this.playerDebugMesh = new THREE.Mesh(
        computeGeometryBoundsTree(
          new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_SEGMENT, 8, 16),
        ),
        new THREE.MeshStandardMaterial({
          color: 0x87f5b1,
          transparent: false,
          opacity: 1,
        }),
      );
      this.playerDebugMesh.visible = false;
      ctx.scene.add(this.playerDebugMesh);
    }
  }

  enter(ctx) {
    this.active = true;
    const activationId = ++this.activationId;
    const savedPosition = ctx.playerReady
      ? ctx.runtime.physicsState.position.clone()
      : null;
    this.ensureInitialized()
      .then(() => {
        if (!this.active || activationId !== this.activationId) return;
        this.rebuildFromCollision(ctx);
        this.ensurePlayerBody(ctx);
        if (savedPosition) {
          this.setPlayerPosition(ctx, savedPosition);
        }
      })
      .catch((error) =>
        ctx.setStatus?.(`rapier init failed: ${error.message || error}`, true),
      );
  }

  exit() {
    this.active = false;
    this.activationId += 1;
    if (this.playerDebugMesh) {
      this.playerDebugMesh.visible = false;
    }
  }

  update(ctx, dt) {
    if (!this.active) return;
    if (
      !this.world ||
      !this.playerBody ||
      !this.characterController ||
      !this.playerCollider
    ) {
      return;
    }

    const state = ctx.runtime.physicsState;
    const requested = {
      x: state.requestedMove.x,
      y: state.verticalVelocity * dt,
      z: state.requestedMove.z,
    };
    this.characterController.computeColliderMovement(
      this.playerCollider,
      requested,
    );
    const corrected = this.characterController.computedMovement();
    const position = this.playerBody.translation();
    const next = {
      x: position.x + corrected.x,
      y: position.y + corrected.y,
      z: position.z + corrected.z,
    };
    this.playerBody.setNextKinematicTranslation(next);
    state.grounded = this.characterController.computedGrounded();
    if (state.grounded && state.verticalVelocity < 0) {
      state.verticalVelocity = 0;
    }
    this.world.step();

    const nextPosition = this.playerBody.translation();
    state.position.set(nextPosition.x, nextPosition.y, nextPosition.z);
    if (this.playerDebugMesh) {
      this.playerDebugMesh.visible = true;
      this.playerDebugMesh.position.copy(state.position);
    }
  }

  setPlayerPosition(ctx, pos) {
    if (!this.playerBody || !pos) return false;
    const next = {
      x: Number(pos.x) || 0,
      y: Number(pos.y) || 0,
      z: Number(pos.z) || 0,
    };
    this.playerBody.setNextKinematicTranslation(next);
    this.playerBody.setTranslation(next, true);
    if (ctx?.runtime?.physicsState?.position) {
      ctx.runtime.physicsState.position.set(next.x, next.y, next.z);
      ctx.runtime.physicsState.requestedMove.set(0, 0, 0);
      ctx.runtime.physicsState.verticalVelocity = 0;
      ctx.runtime.physicsState.grounded = false;
    }
    if (this.playerDebugMesh) {
      this.playerDebugMesh.visible = true;
      this.playerDebugMesh.position.set(next.x, next.y, next.z);
    }
    return true;
  }

  resetPlayer(ctx) {
    const origin = { x: 0, y: 0, z: 0 };
    if (this.playerBody) {
      this.playerBody.setNextKinematicTranslation(origin);
      this.playerBody.setTranslation(origin, true);
    }
    const state = ctx?.runtime?.physicsState;
    if (state) {
      state.position.set(0, 0, 0);
      state.requestedMove.set(0, 0, 0);
      state.verticalVelocity = 0;
      state.grounded = false;
      state.horizontalSpeed = 0;
    }
    if (this.playerDebugMesh) this.playerDebugMesh.visible = false;
  }
}

function isHierarchyPhysicsEnabled(object) {
  let current = object;
  while (current) {
    if (current.userData?.manualEnabled === false) return false;
    current = current.parent;
  }
  return true;
}
