/**
 * RoutineEngine — v2-only execution engine (re-export shim).
 *
 * src/boot/routine.ts imports RoutineEngine from this module.
 * The real implementation lives in src/routines/v2/routine-engine-v2.ts.
 * This file re-exports so existing import paths continue to resolve.
 */
export { RoutineEngineV2 as RoutineEngine } from "../routines/v2/routine-engine-v2.js";
export type {
  RoutineEngineV2Deps as RoutineEngineDeps,
  RoutineV2RunInput as Routine,
  RoutineV2Result as RoutineResult,
  RoutineEngineV2 as RoutineEngineType,
} from "../routines/v2/routine-engine-v2.js";
