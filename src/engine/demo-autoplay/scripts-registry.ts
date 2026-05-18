/**
 * Live Auto-play — scripted-turn registry (Tutorial-X3).
 *
 * Phase 1 of demo-autoplay shipped a single `meeting-summary-demo.json`
 * script. The Tutorial-X extension adds three more — one per LVIS plugin
 * category — and rotates between them so the user sees a different first
 * scenario each boot.
 *
 * Rotation policy:
 *   - Per-install index persists under `~/.lvis/onboarding/autoplay-rotation.json`
 *     via `features.demoAutoplayRotationIndex` (a single integer field on
 *     the existing settings store; no new namespace needed because the
 *     index is one int).
 *   - Selecting a script bumps the index. `useDemoAutoplay` increments
 *     when it picks the script, before passing it to the engine.
 *   - When `LVIS_DEMO_VENDOR` is set and the index is unreadable the
 *     fallback is the first script in `DEMO_SCRIPTS`.
 *
 * Why an array of imports rather than a directory glob:
 *   - The renderer is bundled via tsc + Vite-like resolution; JSON imports
 *     are static so a glob would require a build-time index step.
 *   - The catalog is small (4 entries) so the explicit list is also a
 *     human-readable index.
 */
import type { ScriptedTurn } from "./types.js";
import meetingSummary from "./scripts/meeting-summary-demo.json" with { type: "json" };
import docSearch from "./scripts/doc-search-demo.json" with { type: "json" };
import workProactive from "./scripts/work-proactive-demo.json" with { type: "json" };
import multiAgent from "./scripts/multi-agent-demo.json" with { type: "json" };

/**
 * Ordered list of demo scripts. The index used at runtime wraps around
 * via modulo so the catalog can grow / shrink without an index migration.
 */
export const DEMO_SCRIPTS: readonly ScriptedTurn[] = [
  meetingSummary as ScriptedTurn,
  docSearch as ScriptedTurn,
  workProactive as ScriptedTurn,
  multiAgent as ScriptedTurn,
] as const;

/**
 * Resolve the script that should play on this boot. The index is read
 * from the (caller-provided) persisted setting; out-of-range / invalid
 * values default to 0.
 */
export function pickScript(rotationIndex: number | undefined): ScriptedTurn {
  if (DEMO_SCRIPTS.length === 0) {
    // Defensive — should never happen at runtime because the array is
    // statically defined non-empty. Throw rather than silently returning
    // a stub so the failure is loud.
    throw new Error("demo-scripts-registry: catalog is empty");
  }
  const idx =
    typeof rotationIndex === "number" && Number.isFinite(rotationIndex)
      ? ((rotationIndex % DEMO_SCRIPTS.length) + DEMO_SCRIPTS.length) %
        DEMO_SCRIPTS.length
      : 0;
  return DEMO_SCRIPTS[idx];
}

/** Bump the rotation index. `undefined` → 1 so the next boot lands on script 1. */
export function nextRotationIndex(current: number | undefined): number {
  const base =
    typeof current === "number" && Number.isFinite(current) ? current : 0;
  return (base + 1) % DEMO_SCRIPTS.length;
}
