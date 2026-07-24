/**
 * Provenance-fence sanitizer — the ONE place a host fence's closing tag is neutralized.
 *
 * The host frames untrusted text in a labelled fence so the model knows who authored it:
 *   · `<app-message source="app:…">`            — an MCP App's `ui/message` text
 *   · `<imported-from-proactive source="overlay:…">` — a plugin's overlay trigger prompt
 *   · `<mcp-app-context trust="untrusted-app-data">` — a card's model-context slot
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
  | "lvis-mcp-server-guidance";

/**
 * Neutralize any closing tag for `tag` inside app/plugin-authored `text`, so the body
 * cannot close the fence that frames it and continue outside.
 *
 * Case-insensitive and whitespace-tolerant (`</APP-MESSAGE>`, `</ app-message >`): the
 * consumer is a model reading prose, not a strict XML parser, so a near-miss close is
 * just as effective an escape as an exact one. The original spelling is preserved, with
 * the `<` escaped — the text stays readable and the tag stops being a tag.
 */
export function neutralizeFenceClose(text: string, tag: FenceTag): string {
  return text.replace(new RegExp(`</\\s*${tag}\\s*>`, "gi"), (match) => `<\\${match.slice(1)}`);
}
