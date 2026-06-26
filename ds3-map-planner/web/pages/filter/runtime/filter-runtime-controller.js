import * as THREE from "three";
import { StageManager } from "../stage-definitions/stage-manager.js";
import {
  DEFAULT_STAGE_ID,
  createPlannerStageDefinitions,
} from "../stage-definitions/stage-definitions.js";
import { CollisionSystem } from "../systems/collision-system.js";
import { NavProbeSystem } from "../systems/nav-probe-system.js";
import { NavSystem } from "../systems/nav-system.js";
import { PhysicsSystem } from "../systems/physics-system.js";
import { ThirdPersonControllerSystem } from "../systems/third-person-controller-system.js";

export class FilterRuntimeController {
  constructor() {
    this.runtime = {
      physicsState: {
        position: new THREE.Vector3(0, 3, 0),
        requestedMove: new THREE.Vector3(),
        verticalVelocity: 0,
        grounded: false,
        horizontalSpeed: 0,
      },
    };

    this.physicsSystem = new PhysicsSystem();
    this.thirdPersonSystem = new ThirdPersonControllerSystem();
    this.navProbeSystem = new NavProbeSystem();
    this.collisionSystem = new CollisionSystem();
    this.navSystem = new NavSystem();
    this.systems = {
      collision: this.collisionSystem,
      nav: this.navSystem,
      physics: this.physicsSystem,
      thirdPerson: this.thirdPersonSystem,
      navProbe: this.navProbeSystem,
    };

    this.stageManager = new StageManager(
      createPlannerStageDefinitions({
        onUpdateStage: (_stageId, ctx, dt) => {
          this.physicsSystem.update(ctx, dt);
          this.thirdPersonSystem.update(ctx, dt);
          this.navProbeSystem.update(ctx, dt);
        },
      }),
      DEFAULT_STAGE_ID,
    );
  }

  get defaultStage() {
    return DEFAULT_STAGE_ID;
  }
}
