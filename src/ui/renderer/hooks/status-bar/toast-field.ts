/**
 * Toast field sanitization.
 *
 * Status-bar toasts render values that arrive from untrusted sources — IPC
 * payloads (plugin slug, vendor label) and error text bubbled up from a
 * failed install. Both reach the DOM as text, so the risk is not markup but
 * control characters: a raw `\r`, `\x1b`, or NUL inside a slug corrupts the
 * single-line toast layout and any log line the same string is written to.
 *
 * `sanitizeToastField` therefore drops the C0 range (0x00–0x1F) and DEL
 * (0x7F) and clamps length. C1 (0x80–0x9F) is deliberately not stripped —
 * these values are UTF-16 strings, not decoded bytes, so C1 code points do
 * not appear from mis-decoded input the way C0 does.
 */
export const TOAST_FIELD_MAX = 120;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
export function sanitizeToastField(input: unknown, max: number = TOAST_FIELD_MAX): string {
  return String(input ?? "unknown").replace(CONTROL_CHARS, "").slice(0, max);
}
