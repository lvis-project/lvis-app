/**
 * App auto-update state machine — single source of truth for the
 * discriminated union used across main, preload, and renderer surfaces.
 *
 * Before this SoT, the type was declared inline in 4 places
 * (auto-updater.ts, preload.ts, types.ts, MainToolbar.tsx). Adding a new
 * variant required editing all 4 sites — direct violation of the
 * "Field-Addition Sweep" rule. Importing from here keeps every consumer
 * in lockstep.
 *
 * Lives in `src/shared/` (not main/ or renderer/) so both the main-process
 * auto-updater and the renderer's preload bridge + UI hook can depend on
 * it without forming a cross-boundary import (shared/ is the neutral
 * module zone for cross-process contracts).
 */

export type UpdateState =
  /** No known update — default; never re-emits after first sync. */
  | { kind: "idle" }
  /** Feed reports a newer version. User must click badge to start download. */
  | { kind: "available"; version: string }
  /** Download in flight. Badge shows percent. Click is a no-op. */
  | { kind: "downloading"; version: string; percent: number }
  /** Local zip ready. Click → quitAndInstall. */
  | { kind: "downloaded"; version: string };
