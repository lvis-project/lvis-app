/**
 * Proactive origin pattern — single source of truth.
 *
 * Shared by:
 *   - src/boot/steps/plugin-runtime.ts (evaluateTriggerSpec gate)
 *   - src/permissions/permission-manager.ts (isProactiveOrigin helper)
 *   - src/core/keyword-engine.ts (imported-trigger envelope parser)
 *
 * Must match `^proactive:[a-z][a-z0-9-]*$`.
 * Examples: "proactive:meeting-detection", "proactive:email-triage".
 */

export const PROACTIVE_SOURCE_PATTERN = /^proactive:[a-z][a-z0-9-]*$/;

/**
 * Returns true iff `source` is a valid proactive origin tag.
 * Strict — rejects "proactive:", "proactive:_x", "proactive:Bad/Path".
 */
export function isProactiveOrigin(source: string | null | undefined): boolean {
  return typeof source === "string" && PROACTIVE_SOURCE_PATTERN.test(source);
}

/** Envelope tag that wraps proactive-imported trigger text. */
const IMPORTED_TRIGGER_ENVELOPE_PATTERN =
  /^<imported-from-proactive\s+source="(proactive:[a-z][a-z0-9-]*)"\s*>/;

/**
 * Parses an `<imported-from-proactive source="proactive:…">` envelope prefix.
 * Returns the source tag (e.g. `"proactive:meeting-detection"`) if present,
 * or `null` if the input does not begin with the envelope.
 */
export function parseImportedTriggerEnvelope(input: string): string | null {
  const m = input.trimStart().match(IMPORTED_TRIGGER_ENVELOPE_PATTERN);
  return m ? m[1] : null;
}
