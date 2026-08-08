/**
 * View keys — the app's location vocabulary, defined once for both processes.
 *
 * A view key names a destination: a built-in surface (`home`, `work-board`, …)
 * or a plugin one (`plugin:<pluginId>:<viewId>`). It is the value behind the
 * renderer's `activeView`.
 *
 * Before this module the vocabulary lived in two places that disagreed: the
 * main process held a regex allow-list for the keys a window may be opened
 * with, while the renderer held no list at all and treated `activeView` as a
 * bare `string` — so a typo did not fail, it fell through the render chain and
 * was rendered as a plugin view that does not exist. Both halves now derive
 * from the one table below.
 *
 * The table used to carry a `detachable` column and an OS window title per
 * built-in, because a key could also name a destination opened in its own
 * window. Detach is retired: every destination renders inline, so a key's only
 * question is what it IS, and the columns that answered "where may it be
 * opened" went with the feature that asked.
 */

/** Every built-in destination. THE source of truth for the renderer's union type,
 *  so a new surface is added here and nowhere else. */
export const BUILTIN_VIEWS = {
  home: {},
  settings: {},
  "work-board": {},
  routines: {},
  memory: {},
  starred: {},
  insights: {},
} as const satisfies Record<string, Record<string, never>>;

type BuiltinViewKey = keyof typeof BUILTIN_VIEWS;

export type PluginViewKey = `plugin:${string}:${string}`;

/** Anything the main window can render as `activeView`. */
export type InlineViewKey = BuiltinViewKey | PluginViewKey;

/**
 * Parsing asks what a key IS, and must accept everything the app can legally
 * produce. A plugin id is schema-constrained (`^[a-z][a-z0-9-]*$`), but a UI
 * extension id is declared as a bare `string` in
 * `schemas/plugin-manifest.schema.json` — so `plugin:my-plugin:MainView` is a
 * valid, shipping key. Parsing therefore asserts STRUCTURE only: a non-empty
 * segment is anything without a colon, since the colon is what separates them.
 */
const STRUCTURAL_SEGMENT_RE = /^[^:]+$/;

/** A view key taken apart. `null` from `parseViewKey` means "not a view key". */
export type ParsedViewKey =
  | { kind: "builtin"; key: BuiltinViewKey }
  | { kind: "plugin"; key: PluginViewKey; pluginId: string; viewId: string };

/**
 * The single parser. Every consumer that needs to know what a key IS goes
 * through here instead of re-testing prefixes — `startsWith("plugin:")` was
 * true for the malformed `plugin:` too, and callers each decided what that
 * meant.
 */
export function parseViewKey(raw: string): ParsedViewKey | null {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_VIEWS, raw)) {
    return { kind: "builtin", key: raw as BuiltinViewKey };
  }

  // `split` with a limit would silently accept trailing segments, so take the
  // prefix off and require the remainder to be exactly two segments.
  if (raw.startsWith("plugin:")) {
    const rest = raw.slice("plugin:".length);
    const separator = rest.indexOf(":");
    if (separator <= 0) return null;
    const pluginId = rest.slice(0, separator);
    const viewId = rest.slice(separator + 1);
    if (!STRUCTURAL_SEGMENT_RE.test(pluginId) || !STRUCTURAL_SEGMENT_RE.test(viewId)) return null;
    return { kind: "plugin", key: raw as PluginViewKey, pluginId, viewId };
  }

  return null;
}

/** Build a plugin view key. The only place this shape is spelled out. */
export function pluginViewKey(pluginId: string, viewId: string): PluginViewKey {
  return `plugin:${pluginId}:${viewId}`;
}

/** True when `raw` can be the main window's `activeView`. */
export function isInlineViewKey(raw: string): raw is InlineViewKey {
  const kind = parseViewKey(raw)?.kind;
  return kind === "builtin" || kind === "plugin";
}

/** A view key that the main window can actually be AT. */
export type ParsedInlineViewKey =
  | { kind: "builtin"; key: BuiltinViewKey }
  | { kind: "plugin"; key: PluginViewKey; pluginId: string; viewId: string };

/**
 * Parse, and simultaneously answer "can the main window be here?".
 *
 * Navigation call sites need both facts at once, and asking two separate
 * questions gives the compiler no way to connect them — the caller ends up
 * knowing the key is inline while still holding a type that says it might be
 * an MCP-app card. Returning the narrowed shape keeps the runtime guard and
 * the static type telling the same story.
 */
export function parseInlineViewKey(raw: string): ParsedInlineViewKey | null {
  const parsed = parseViewKey(raw);
  if (!parsed) return null;
  if (parsed.kind === "plugin") return parsed;
  // MCP-app cards are the only keys that name a real destination the main
  // window cannot render.
  if (parsed.kind !== "builtin") return null;
  return { kind: "builtin", key: parsed.key };
}
