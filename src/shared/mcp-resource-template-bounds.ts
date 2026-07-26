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
 * A surrogate code unit with no partner — the input that makes `encodeURIComponent` throw
 * rather than return. Not global, so `lastIndex` is never carried between calls.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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
 * Does any path segment of this URI mean "here" or "up one"?
 *
 * `encodeURIComponent` leaves `.` alone — it is unreserved — so a value of `..` reaches
 * the server verbatim AS A DOT SEGMENT. `file:///project/{dir}/{name}` filled with `..`
 * and `id_rsa` produces `file:///project/../id_rsa`, which resolves to `file:///id_rsa`.
 * Percent-encoding stops a value spanning segments; it does nothing about a value that
 * IS one. RFC 3986 dot-segment removal is not a "badly written server" hazard either: it
 * is what `new URL()` and `fileURLToPath` do, for non-special schemes too.
 *
 * Checked on the FINISHED string rather than on each value, because a literal can compose
 * one: `file:///project/.{x}` with `x="."` is a dot segment neither half contains. Query
 * and fragment are dropped first — a `..` after `?` is not a path segment, and the only
 * way one gets there is from a literal the server itself wrote.
 *
 * `%2e` is decoded before comparing, because WHATWG's definition of a double-dot segment
 * is `..`, `.%2e`, `%2e.` or `%2e%2e`, ASCII case-insensitive — all four resolve, and a
 * literal-only comparison sees none of them. A VALUE cannot produce these on its own
 * (`encodeURIComponent` emits `.` as `.`, never as `%2e`, and turns a typed `%` into
 * `%25`), so reaching them needs a server literal `%` next to the variable — the same
 * literal-plus-value composition this function already exists to catch, one encoding down.
 */
function hasDotSegment(uri: string): boolean {
  const scheme = uri.indexOf(":");
  const afterScheme = scheme === -1 ? uri : uri.slice(scheme + 1);
  const pathEnd = afterScheme.search(/[?#]/);
  const path = pathEnd === -1 ? afterScheme : afterScheme.slice(0, pathEnd);
  return path.split("/").some((raw) => {
    const segment = raw.replace(/%2e/gi, ".");
    return segment === "." || segment === "..";
  });
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

  // The cheap half first. A string with no Level 1 expression at all is not a template,
  // and this is also the ONLY one of the two counts that decides a case by itself —
  // ordered this way because the loose scan below is ~1000× dearer on a pathological
  // brace run, and discovery runs it once per entry a server publishes.
  const strict = [...value.matchAll(TEMPLATE_EXPRESSION_RE)];
  if (strict.length === 0) return false;

  // Then: every brace run must BE one of those expressions. An operator (`{+path}`), a
  // modifier (`{path:3}`), an explode (`{list*}`), an empty `{}` or a stray brace matches
  // the loose pattern and not the strict one, so the counts differ.
  //
  // Redundant in practice, and deliberately kept: a brace that survives this check also
  // survives into the skeleton, and `isUsableResourceUri` refuses `{` and `}` outright —
  // so the skeleton is what actually kills every operator fixture. The count stays
  // because it refuses for the RIGHT REASON, at the layer that knows about RFC 6570,
  // rather than relying on a URI rule that happens to exclude braces for its own reasons.
  const loose = [...value.matchAll(ANY_BRACE_RUN_RE)];
  if (strict.length !== loose.length) return false;
  if (resourceTemplateVariables(value).length > MCP_RESOURCE_TEMPLATE_MAX_VARIABLES) {
    return false;
  }

  // The skeleton with a benign placeholder standing in for each variable. `x` is
  // unreserved, so a skeleton that fails here fails for a reason that has nothing to do
  // with the substitution.
  const skeleton = value.replace(TEMPLATE_EXPRESSION_RE, "x");
  if (!isUsableResourceUri(skeleton)) return false;

  // A dot segment in the LITERAL part is refused here rather than left to the expansion.
  // `isUsableResourceUri` permits one — a server may publish `file:///a/../b` as a plain
  // resource and that is its own business — but for a template it would catalogue a row
  // whose every read the expansion then refuses. That is the dead-row shape: a picker
  // entry that exists only to fail, blaming the server for a rule the host applied.
  //
  // THIS CHECK IS NOT THE GATE, and must never be read as making the expansion's one
  // redundant. It sees only the skeleton, so `{path}` filled with `..` is invisible to
  // it — the expansion strictly subsumes it, not the other way round. Deleting this line
  // costs dead rows; deleting the one in `expandResourceUriTemplate` reintroduces the
  // traversal. Same split as `hostFetchRefused`: derived at discovery for the picker,
  // re-derived at read for enforcement (policy §3).
  return !hasDotSegment(skeleton);
}

/**
 * Fill a template. Returns the URI, or `null` when the result is not one the host would
 * have accepted from `resources/list` in the first place.
 *
 * Every value is percent-encoded with `encodeURIComponent`, which is Level 1's rule and
 * the reason a value cannot span components: `/`, `?`, `#`, `:` and `@` all encode. What
 * that does NOT do is stop a value from BEING a dot segment, which is why
 * {@link hasDotSegment} runs on the result — see its comment, and note that the test
 * which "proved" traversal was neutralized used `../../etc/passwd`, whose slashes encode.
 * Bare `..` went untried until a review found it.
 *
 * The result is then validated with the ORDINARY URI predicate. That is NOT a belt to
 * anything's suspenders, despite what an earlier version of this comment called it: a
 * variable may sit in scheme position (`{scheme}://host/{p}` catalogues, because the
 * skeleton `x://host/x` is a legal custom scheme), and percent-encoding cannot help there
 * because `javascript` and `ui` are already unreserved. This line is the only thing
 * between that template and a reserved scheme, and it is pinned by its own test.
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
    // A lone surrogate makes `encodeURIComponent` THROW. Refused here so this function
    // keeps the contract its signature states — returns a string or `null`, never
    // raises — which the one caller today survives by luck of a `try` it has for other
    // reasons. Reachable from the dialog, whose `maxLength` can clip a pasted emoji in
    // half.
    if (LONE_SURROGATE_RE.test(trimmed)) {
      refused = true;
      return "";
    }
    return encodeURIComponent(trimmed);
  });
  if (refused) return null;
  if (expanded.length > MCP_RESOURCE_URI_MAX_CHARS) return null;
  if (hasDotSegment(expanded)) return null;
  return isUsableResourceUri(expanded) ? expanded : null;
}
