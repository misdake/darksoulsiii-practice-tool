export const DEFAULT_STAGE_ID = 1;
import { createStage1CollisionFilterDefinition } from "./defs/stage1_collision_filter.js";
import { createStage2NavFilterDefinition } from "./defs/stage2_nav_filter.js";
import { createStage3MarkNavDefinition } from "./defs/stage3_mark_nav.js";
import { createStage4ShotPlanDefinition } from "./defs/stage4_shot_plan.js";

function withRuntimeHooks(def, stageId, runtimeHooks) {
  const stageEnter = def.enter;
  const stageExit = def.exit;
  const stageUpdate = def.update;
  return {
    ...def,
    enter: (ctx) => {
      runtimeHooks?.onEnterStage?.(stageId, ctx);
      stageEnter?.(ctx);
    },
    exit: (ctx) => {
      stageExit?.(ctx);
      runtimeHooks?.onExitStage?.(stageId, ctx);
    },
    update: (ctx, dt) => {
      stageUpdate?.(ctx, dt);
      runtimeHooks?.onUpdateStage?.(stageId, ctx, dt);
    },
  };
}

export function createPlannerStageDefinitions(runtimeHooks = null) {
  const raw = {
    1: createStage1CollisionFilterDefinition(),
    2: createStage2NavFilterDefinition(),
    3: createStage3MarkNavDefinition(),
    4: createStage4ShotPlanDefinition(),
  };
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[Number(k)] = withRuntimeHooks(v, Number(k), runtimeHooks);
  return out;
}
