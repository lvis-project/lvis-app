/**
 * Scripted-turn registry for the ScenarioShowcase inline preview.
 *
 * Holds the four canonical demo scripts (one per LVIS plugin category). The
 * onboarding ScenarioShowcase plays one inline when the user clicks a scenario
 * card; `getScriptByScenarioId()` resolves a card id to its scripted turn.
 *
 * (The former boot-time "Live Auto-play" full-screen rotation that also
 * consumed these scripts has been removed — only the user-initiated preview
 * remains.)
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
import workAssistant from "./scripts/work-assistant-demo.json" with { type: "json" };
import multiAgent from "./scripts/multi-agent-demo.json" with { type: "json" };

/**
 * Ordered list of demo scripts. The index used at runtime wraps around
 * via modulo so the catalog can grow / shrink without an index migration.
 *
 * Catalog mapping (ScenarioShowcase Option A — 2026-05-19):
 *   meeting       → meeting-summary-demo
 *   docs          → doc-search-demo
 *   work          → work-assistant-demo
 *   multi-agent   → multi-agent-demo
 *
 * `getScriptByScenarioId()` resolves a ScenarioShowcase card id to the
 * matching scripted turn so the inline demo surface plays the right
 * scenario for the card the user clicked.
 */
export const DEMO_SCRIPTS: readonly ScriptedTurn[] = [
  meetingSummary as ScriptedTurn,
  docSearch as ScriptedTurn,
  workAssistant as ScriptedTurn,
  multiAgent as ScriptedTurn,
] as const;

/**
 * ScenarioShowcase card id → scripted turn lookup. Returns `null` if the
 * scenario id is not part of the catalog so the caller can defer to the
 * regular rotation (or surface a no-op).
 */
export function getScriptByScenarioId(
  scenarioId: string | null | undefined,
): ScriptedTurn | null {
  if (!scenarioId) return null;
  switch (scenarioId) {
    case "meeting":
      return meetingSummary as ScriptedTurn;
    case "docs":
      return docSearch as ScriptedTurn;
    case "work":
      return workAssistant as ScriptedTurn;
    case "multi-agent":
      return multiAgent as ScriptedTurn;
    default:
      return null;
  }
}
