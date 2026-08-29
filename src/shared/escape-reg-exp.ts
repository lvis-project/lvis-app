/**
 * Escape a string so it matches itself literally inside a `RegExp`.
 *
 * Four copies of this existed — in `memory/memory-manager.ts`,
 * `shared/tool-name-aliases.ts`, `audit/dlp-filter.ts` and inline in
 * `plugins/marketplace-update-recovery.ts` — with the same character class
 * written in two different orders. Every one of them wraps attacker- or
 * user-influenced text (a project name, a tool alias, the home directory
 * path, a plugin id) into a pattern, so a character missing from one copy is
 * not a formatting difference: it is a pattern that matches more than the
 * caller asked for.
 *
 * It gets its own module rather than joining an existing one because its four
 * importers sit in four different domains, and `shared/` has no general string
 * utility file to join — `shared/is-record.ts` is the same shape.
 *
 * NOT the same as the escapes in `lib/glob-matcher.ts` and
 * `mcp/mcp-governance.ts`: those deliberately leave `*` unescaped because they
 * translate it into `.*` themselves.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
