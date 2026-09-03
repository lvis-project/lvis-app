/**
 * Managed bootstrap status — single source of truth for the discriminated
 * union reported around `ensureManagedInstalled()` across the main process,
 * the preload bridge, and the renderer.
 *
 * Before this SoT the union was declared inline in 4 places
 * (`boot/bootstrap-status.ts`, `preload/internal-api-surface.ts`,
 * `ui/renderer/types.ts`, `ui/renderer/hooks/use-bootstrap-status.ts`), so
 * adding a variant or a field meant editing all 4 — the "Field-Addition
 * Sweep" rule this repository forbids breaking.
 *
 * Lives in `src/shared/` (not `boot/` or `ui/renderer/`) so the main-process
 * emitter and the renderer's preload bridge + UI hook can each depend on it
 * without forming a cross-boundary import; `shared/` is the neutral module
 * zone for cross-process contracts.
 */

export type AppBootstrapStatus =
  /** Bootstrap call enqueued — the renderer can show a quiet spinner. */
  | { phase: "start" }
  /** Finished. `installed` and `failed` are plugin IDs; `skippedReason` comes
   *  from `resolveManagedPluginBootstrap` when the call was skipped entirely. */
  | {
      phase: "complete";
      installed: string[];
      failed: Array<{ id: string; error: string }>;
      skippedReason?: string;
    }
  /** Bootstrap itself threw (catalog fetch failure, etc.). `message` is a
   *  single sentence, surfaced verbatim to the renderer banner. */
  | { phase: "error"; message: string };
