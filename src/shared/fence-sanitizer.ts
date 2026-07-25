/**
 * Provenance-fence sanitizer — the ONE place a host fence's closing tag is neutralized.
 *
 * The host frames untrusted text in a labelled fence so the model knows who authored it:
 *   · `<app-message source="app:…">`            — an MCP App's `ui/message` text
 *   · `<imported-from-proactive source="overlay:…">` — a plugin's overlay trigger prompt
 *   · `<mcp-app-context trust="untrusted-app-data">` — a card's model-context slot
 *   · `<mcp-resource trust="untrusted-server-data">` — a server resource the USER
 *     attached to their own turn (the turn stays theirs; only the body is untrusted)
 *
 * The fence IS the labelling mechanism, so a body that can emit its own closing tag
 * defeats it: everything the author writes after that tag appears, to the model, to sit
 * OUTSIDE the untrusted region. {@link neutralizeFenceClose} is the single fix, applied
 * by each fence's ONE builder — never re-checked downstream, never re-implemented.
 *
 * {@link FenceTag} is a closed union on purpose: the tag is a host constant interpolated
 * into a RegExp, so it can never be caller/app-controlled, and a new fence has to register
 * here (which is the moment its builder gets asked whether it escapes).
 */

/** Every provenance fence the host builds around untrusted text. */
export type FenceTag =
  | "app-message"
  | "imported-from-proactive"
  | "mcp-app-context"
  | "lvis-mcp-server-guidance"
  | "mcp-prompt"
  | "mcp-resource";

/**
 * Neutralize any closing tag for `tag` inside app/plugin-authored `text`, so the body
 * cannot close the fence that frames it and continue outside.
 *
 * Case-insensitive and whitespace-tolerant on BOTH sides of the slash (`</APP-MESSAGE>`,
 * `</ app-message >`, `< /app-message>`): the
 * consumer is a model reading prose, not a strict XML parser, so a near-miss close is
 * just as effective an escape as an exact one. The original spelling is preserved, with
 * the `<` escaped — the text stays readable and the tag stops being a tag.
 */
export function neutralizeFenceClose(text: string, tag: FenceTag): string {
  return text.replace(new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi"), (match) => `<\\${match.slice(1)}`);
}

/**
 * Neutralize any OPENING tag for `tag` inside `text`, the same way as the close.
 *
 * Needed wherever the NUMBER of host-built frames is load-bearing, not just their
 * boundaries. The resource fence is counted at the turn-entry chokepoint to bound how
 * much server text one turn carries; a body free to print `<mcp-resource …` would let
 * a single hostile resource inflate that count past the budget and refuse every send
 * the user attempts — a denial of service authored by the data.
 *
 * The other fences do not call this: an opening tag inside a body cannot END the
 * region, so for them the close is the whole escape. Applied only where the extra
 * property is actually relied on, so the cheaper rule stays the default.
 */
export function neutralizeFenceOpen(text: string, tag: FenceTag): string {
  return text.replace(new RegExp(`<\\s*${tag}\\b`, "gi"), (match) => `<\\${match.slice(1)}`);
}

/**
 * Make a non-literal value safe to print INSIDE a fence's OPEN tag, and bound it.
 *
 * The close tag is not the only way out of a fence: an attribute value carrying `">`
 * ends the open tag on line 1 and puts everything after it OUTSIDE the fence, next
 * to the user's own words, with the untrusted framing then applying to nothing. That
 * escape shipped once here — through a server-chosen resource URI — which is why it
 * lives beside {@link neutralizeFenceClose} instead of inside one builder: the next
 * fence with an attribute finds it, rather than rediscovering the bug.
 *
 * Whitespace collapses as well as `"`, `<` and `>` are stripped. That does not keep
 * prose out of the attribute — a value is still printed there — it keeps the open tag
 * on ONE LINE, so a value carrying a newline cannot break the header apart and have
 * the remainder read as framing.
 *
 * The host's other two attributed fences protect the same position differently, and
 * both are stronger where they apply: `staged-origins.ts` throws unless the value
 * matches the fence's own `sourcePattern` (fail-closed, no sanitizing), and
 * `mcp-app-model-context.ts` interpolates nothing but host literals. Reach for this
 * one only where the value genuinely comes from outside.
 */
export function fenceAttrValue(value: string, maxChars: number): string {
  return value.slice(0, maxChars).replace(/["<>]/g, "").replace(/\s+/g, " ").trim();
}
