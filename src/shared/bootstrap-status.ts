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

/**
 * Why a managed-plugin bootstrap pass was skipped instead of run.
 *
 * Closed, because the renderer has to translate it. A free-form reason string
 * reaches the user as whatever English the producer happened to write, dropped
 * verbatim into a Korean sentence, and a boolean-ish "there is a reason" test
 * cannot tell a policy decision (no network pass in an isolated E2E run) from a
 * failure (the catalog did not answer) — so the pill said "Marketplace
 * bootstrap skipped" for a skip that had nothing to do with the marketplace.
 *
 *   - `e2e-isolated`        — isolated E2E runtime; the network pass is off by
 *                             policy and nothing is wrong.
 *   - `no-base-url`         — no marketplace address is configured, so there is
 *                             no catalog to ask.
 *   - `catalog-unreachable` — the catalog request failed. The only code that
 *                             carries `detail`.
 */
export type BootstrapSkipReason =
  | "e2e-isolated"
  | "no-base-url"
  | "catalog-unreachable";

/**
 * A skip as reported across the wire: the closed code, plus — at the network
 * boundary only — the message the failed request produced. `detail` is
 * untranslated transport text, so a consumer appends it to a sentence it
 * translated from `reason` rather than interpolating it into one.
 */
export interface BootstrapSkip {
  reason: BootstrapSkipReason;
  detail?: string;
}

/**
 * The code has exactly two renderings, and both live here with the union so a
 * fourth code cannot be added without deciding how it reads in each.
 *
 * This one is operator prose for the boot log — English, never shown in the UI.
 */
const BOOTSTRAP_SKIP_LOG_TEXT: Record<BootstrapSkipReason, string> = {
  "e2e-isolated": "managed plugin bootstrap disabled in isolated E2E test mode",
  "no-base-url": "marketplace backend has no configured base URL",
  "catalog-unreachable": "catalog unreachable",
};

/**
 * The other rendering: the i18n key whose sentence the renderer shows. The
 * lookup is a computed key, which the literal-key scan in
 * `src/i18n/__tests__/used-keys-exist.test.ts` cannot see, so that suite
 * asserts this table's values against every locale by name.
 */
export const BOOTSTRAP_SKIP_MESSAGE_KEY: Record<BootstrapSkipReason, string> = {
  "e2e-isolated": "bootstrapStatusPill.skippedE2eIsolated",
  "no-base-url": "bootstrapStatusPill.skippedNoBaseUrl",
  "catalog-unreachable": "bootstrapStatusPill.skippedCatalogUnreachable",
};

/** One boot-log line for a skip: prose from the code, plus `detail` when the
 *  network boundary produced any. */
export function describeBootstrapSkip(skip: BootstrapSkip): string {
  const text = BOOTSTRAP_SKIP_LOG_TEXT[skip.reason];
  return skip.detail ? `${text}: ${skip.detail}` : text;
}

export type AppBootstrapStatus =
  /** Bootstrap call enqueued — the renderer can show a quiet spinner. */
  | { phase: "start" }
  /** Finished. `installed` and `failed` are plugin IDs; `skipped` is present
   *  only when the pass was skipped entirely, and says which decision or
   *  failure skipped it. */
  | {
      phase: "complete";
      installed: string[];
      failed: Array<{ id: string; error: string }>;
      skipped?: BootstrapSkip;
    }
  /** Bootstrap itself threw (catalog fetch failure, etc.). `message` is a
   *  single sentence, surfaced verbatim to the renderer banner. */
  | { phase: "error"; message: string };
