/**
 * Proactive origin pattern — single source of truth.
 *
 * Shared by:
 *   - src/boot/steps/plugin-runtime.ts (evaluateTriggerSpec gate)
 *   - src/permissions/permission-manager.ts (isProactiveOrigin helper)
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
