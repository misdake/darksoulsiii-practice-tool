export const DEFAULT_STAGE_ID = 3;
import { createStage1Definition } from "./defs/stage1.js";
import { createStage2Definition } from "./defs/stage2.js";
import { createStage5Definition } from "./defs/stage5.js";

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
    1: createStage1Definition(),
    2: createStage2Definition(),
    3: createStage5Definition(),
  };
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[Number(k)] = withRuntimeHooks(v, Number(k), runtimeHooks);
  return out;
}
