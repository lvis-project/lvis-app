/**
 * Proactive trigger source — single source of truth for the validation
 * pattern that gates the entire brain proactive flow.
 *
 * Five sites previously inlined this regex (or a looser `startsWith`):
 *   - `boot/steps/plugin-runtime.ts`     (host gate at triggerConversation)
 *   - `engine/trigger-executor.ts`       (envelope wrap)
 *   - `core/keyword-engine.ts`           (skill-routing bypass)
 *   - `ipc-bridge.ts`                    (originSource detection)
 *   - `permissions/permission-manager.ts` + `prompts/system-prompt-builder.ts` (loose prefix check)
 *
 * If any one of these drifts (e.g. someone allows underscores in a
 * future detector source), the gates disagree and either:
 *   (a) plugin-supplied imperatives slip through with no guard, or
 *   (b) a legitimate trigger silently fails to activate the
 *       proactive-origin guidance / permission override.
 *
 * Centralizing the pattern + helpers makes that whole class of
 * "fixed in N-1 places" bugs unrepresentable.
 */

/** Strict source pattern. Lowercase + digits + hyphens only, must start with `proactive:`. */
export const PROACTIVE_SOURCE_PATTERN = /^proactive:[a-z][a-z0-9-]*$/;

/**
 * Envelope shape used to wrap brain prompts when imported into chat.
 * The capture group is the source — strict-validated by the same
 * pattern above so consumers can trust the value without re-checking.
 *
 * Anchored to the start (after `trimStart()` at the call site) so a
 * mid-input occurrence (e.g. user typing about an envelope) does not
 * trip the bypass.
 */
export const IMPORTED_TRIGGER_ENVELOPE_PATTERN =
  /^<imported-from-proactive\s+source="(proactive:[a-z][a-z0-9-]*)"\s*>/;

/**
 * True when `source` is a strict-valid proactive source. Use this in
 * gates that need to differentiate "trigger turn" from "user turn"
 * (PermissionManager override, system-prompt guidance activation).
 *
 * Note: this is stricter than `startsWith("proactive:")`. Callers
 * doing the loose prefix check were tolerant of malformed values that
 * could in principle reach them via untrusted paths; the strict check
 * fails closed on malformed input, which is the safer default.
 */
export function isProactiveOrigin(source: unknown): source is string {
  return typeof source === "string" && PROACTIVE_SOURCE_PATTERN.test(source);
}

/**
 * Parse the envelope at the start of `input`. Returns the source
 * string when matched, null otherwise. The returned source is
 * guaranteed to satisfy `PROACTIVE_SOURCE_PATTERN` by construction.
 */
export function parseImportedTriggerEnvelope(input: string): string | null {
  const m = input.trimStart().match(IMPORTED_TRIGGER_ENVELOPE_PATTERN);
  return m ? m[1] : null;
}
