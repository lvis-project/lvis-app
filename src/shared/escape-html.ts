/**
 * Escape a string for interpolation into host-authored HTML, as text or as a
 * double-quoted attribute value. All four entities, in both positions: the
 * superset is always safe, and one function for both contexts is what keeps
 * an attribute escaper from quietly dropping `>` — three of the eight copies
 * this replaced had.
 *
 * A dependency-free leaf, beside `escape-reg-exp.ts`, because its callers
 * are the proxy-document builders and prompt assemblers in main and engine;
 * an escaper that pulled the i18n runtime in behind it would give those
 * modules a dependency they must not have.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
