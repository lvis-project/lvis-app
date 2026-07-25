/**
 * URI TEMPLATES — the shape a server publishes when the user has to fill something in.
 *
 * Separate from `isUsableResourceUri` on purpose, and the reason is the whole design:
 * that predicate refuses `{` and `}` outright, because a URI is a finished identifier
 * and braces in one are a spoofing vector. A template is not a finished identifier — it
 * is a PATTERN the host completes — so it needs its own rule rather than a flag that
 * softens the other one. The resources policy §3 records this as a frozen constraint.
 *
 * ## Only RFC 6570 Level 1, deliberately
 *
 * `{var}` and nothing else. No `{+var}`, `{#var}`, `{/var}`, `{?var}`, `{&var}`, no
 * explode, no prefix modifiers. That is not laziness about the spec — it is the property
 * the whole read path rests on:
 *
 *   - Level 1 expansion percent-encodes everything outside the unreserved set, so a
 *     user typing `../../etc/passwd` produces `..%2F..%2Fetc%2Fpasswd` — one path
 *     segment, not a traversal. `{+var}` is defined as RESERVED expansion, which does
 *     NOT encode `/`, and would hand exactly that traversal to the server.
 *   - a value can never introduce URI STRUCTURE. `/`, `?`, `#`, `:` and `@` all encode,
 *     so whatever the user types stays inside the one component the server put the
 *     variable in.
 *
 * What that does NOT buy, and an earlier version of this comment claimed it did: it does
 * not fix the scheme. A server may publish `{scheme}://host/{path}`, whose skeleton
 * `x://host/x` is a legal server-custom scheme — so the user picks the scheme, and
 * percent-encoding is no help because `javascript` and `ui` are already unreserved. The
 * thing that actually holds is the re-validation of the EXPANSION below: it runs the
 * ordinary URI predicate over the finished string, which is where a reserved scheme dies.
 * The client then re-derives the `https:` refusal from that same expansion. Both are
 * pinned by tests, because "the literal part is fixed" reads like a guarantee and is not
 * one.
 *
 * A server that needs the other operators is refused at discovery and appears nowhere,
 * which is the fail-closed direction: an un-offered template costs a feature, an
 * un-encoded one costs a file read outside what the server meant to publish.
 *
 * ## The expansion is host-side, and that is the security boundary
 *
 * The renderer never sends a URI for a template. It sends the template plus the values,
 * and {@link expandResourceUriTemplate} produces the URI here. The alternative —
 * accepting a URI and pattern-matching it against a listed template — needs a matcher,
 * and a matcher for `file:///{path}` accepts `file:///../../etc/passwd`. There is no
 * version of that check that is simpler than not needing it.
 *
 * Pure: imports only the URI bounds it shares constants with.
 */
import {
  isUsableResourceUri,
  MCP_RESOURCE_URI_MAX_CHARS,
} from "./mcp-resource-bounds.js";

/** Variables one template may declare. A form the user fills, not a payload. */
export const MCP_RESOURCE_TEMPLATE_MAX_VARIABLES = 8;

/** Per-value length the dialog and main both enforce. */
export const MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS = 512;

/**
 * What a variable may be NAMED, written once.
 *
 * The subset of RFC 6570 varnames minus the dotted and pct-encoded forms we do not
 * support. Both the expression pattern below and the standalone name predicate are built
 * from this string, so the rule that decides "this template declares `path`" and the rule
 * that decides "this IPC key is a variable name" cannot drift apart — and a key the
 * dialog could not have rendered is refused at the boundary rather than carried to an
 * expansion that would ignore it.
 */
const VARIABLE_NAME_PATTERN = "[A-Za-z0-9_]{1,64}";

/**
 * A Level 1 expression: `{name}`. Anything else in braces — an operator, a modifier, an
 * empty name — makes the whole template unusable.
 */
const TEMPLATE_EXPRESSION_RE = new RegExp(`\\{(${VARIABLE_NAME_PATTERN})\\}`, "g");

const TEMPLATE_VARIABLE_NAME_RE = new RegExp(`^${VARIABLE_NAME_PATTERN}$`);

/**
 * Is this a name a catalogued template could have declared?
 *
 * The boundary check for values arriving from the renderer. Expansion only reads names
 * the template itself contains, so an unknown key is already inert — but an unbounded
 * one would still be carried, counted and (in a future audit line) printed, and the cost
 * of refusing it here is one comparison.
 */
export function isUsableTemplateVariableName(value: unknown): value is string {
  return typeof value === "string" && TEMPLATE_VARIABLE_NAME_RE.test(value);
}

/** Any brace-delimited run, used to prove nothing exotic hides between the good ones. */
const ANY_BRACE_RUN_RE = /\{[^}]*\}|[{}]/g;

/**
 * Variable names in declaration order, first occurrence only.
 *
 * Order matters because it is the order the dialog renders fields in, and a server that
 * repeats a variable gets one field — the same value substituted at every occurrence,
 * which is what RFC 6570 specifies and what a user filling `{owner}/{repo}/{owner}`
 * would expect.
 */
export function resourceTemplateVariables(uriTemplate: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of uriTemplate.matchAll(TEMPLATE_EXPRESSION_RE)) {
    const name = match[1];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Is this a template the host will catalogue and later expand?
 *
 * Checked by REMOVING every well-formed Level 1 expression and requiring what is left to
 * be a URI the host would accept on its own. That is the trick that keeps this rule and
 * `isUsableResourceUri` from drifting: the literal skeleton has to pass the same scheme
 * allowlist, the same excluded characters, the same invisible-character class — so a
 * template cannot smuggle in a scheme or a bidi override that a plain URI could not.
 */
export function isUsableResourceUriTemplate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MCP_RESOURCE_URI_MAX_CHARS) return false;

  // Every brace run must be a Level 1 expression. Counting them is how an operator
  // (`{+path}`), a modifier (`{path:3}`), an explode (`{list*}`), an empty `{}` or a
  // stray unmatched brace is refused: those match the loose pattern and not the strict
  // one, so the counts differ.
  const strict = [...value.matchAll(TEMPLATE_EXPRESSION_RE)];
  const loose = [...value.matchAll(ANY_BRACE_RUN_RE)];
  if (strict.length === 0) return false;
  if (strict.length !== loose.length) return false;
  if (resourceTemplateVariables(value).length > MCP_RESOURCE_TEMPLATE_MAX_VARIABLES) {
    return false;
  }

  // The skeleton with a benign placeholder standing in for each variable. `x` is
  // unreserved, so a skeleton that fails here fails for a reason that has nothing to do
  // with the substitution.
  const skeleton = value.replace(TEMPLATE_EXPRESSION_RE, "x");
  return isUsableResourceUri(skeleton);
}

/**
 * Fill a template. Returns the URI, or `null` when the result is not one the host would
 * have accepted from `resources/list` in the first place.
 *
 * Every value is percent-encoded with `encodeURIComponent`, which is Level 1's rule and
 * the reason a user cannot type their way out of the path the server published. The
 * result is then validated with the ORDINARY URI predicate — belt to that suspenders,
 * and the thing that makes this function's output indistinguishable from a listed URI to
 * every consumer downstream.
 *
 * A missing or over-long value is a refusal rather than an empty substitution: silently
 * expanding `{path}` to nothing yields a URI pointing at the directory above it, which
 * is a different resource than the user asked for and one they cannot see they asked
 * for.
 */
export function expandResourceUriTemplate(
  uriTemplate: string,
  values: ReadonlyMap<string, string>,
): string | null {
  if (!isUsableResourceUriTemplate(uriTemplate)) return null;

  let refused = false;
  const expanded = uriTemplate.replace(TEMPLATE_EXPRESSION_RE, (_match, name: string) => {
    const value = values.get(name);
    if (typeof value !== "string") {
      refused = true;
      return "";
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS) {
      refused = true;
      return "";
    }
    return encodeURIComponent(trimmed);
  });
  if (refused) return null;
  if (expanded.length > MCP_RESOURCE_URI_MAX_CHARS) return null;
  return isUsableResourceUri(expanded) ? expanded : null;
}
