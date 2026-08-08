/**
 * View keys — the app's location vocabulary, defined once for both processes.
 *
 * A view key names a destination: a built-in surface (`home`, `work-board`, …)
 * or a namespaced one (`plugin:<pluginId>:<viewId>`,
 * `mcp-app:<hex(serverId)>:<cardId>`). It is the value behind the renderer's
 * `activeView`, the argument to the detach IPC, and the payload of the
 * `#detached/<viewKey>` URL fragment.
 *
 * Before this module the vocabulary lived in two places that disagreed: the
 * main process held a regex allow-list for the keys a window may be opened
 * with, while the renderer held no list at all and treated `activeView` as a
 * bare `string` — so a typo did not fail, it fell through the render chain and
 * was rendered as a plugin view that does not exist. Both halves now derive
 * from the one table below.
 *
 * Not every key can appear in every place, and that is a property of the key
 * rather than of the caller:
 *   - `inline` — may be the main window's `activeView`.
 *   - `detachable` — may be opened as its own window.
 * `home` and `settings` are inline-only: they have no detached form.
 */

/** What a built-in destination is allowed to do. */
interface BuiltinViewSpec {
  /** May be the main window's `activeView`. */
  readonly inline: boolean;
  /** May be opened as its own window via the detach IPC. */
  readonly detachable: boolean;
  /**
   * OS window title for the detached form. Required exactly when `detachable`
   * — a window with no title is a defect, and an unused title is dead text.
   * Deliberately not localized: it is the same English text the main process
   * has always used, and moving it into the i18n catalogs is a separate change.
   */
  readonly windowTitle?: string;
}

/**
 * Every built-in destination. THE source of truth — the detach allow-list, the
 * window titles, and the renderer's union type are all derived from it, so a
 * new surface is added here and nowhere else.
 */
export const BUILTIN_VIEWS = {
  home: { inline: true, detachable: false },
  settings: { inline: true, detachable: false },
  "work-board": { inline: true, detachable: true, windowTitle: "Work Board" },
  routines: { inline: true, detachable: true, windowTitle: "Routines" },
  memory: { inline: true, detachable: true, windowTitle: "Memory" },
  starred: { inline: true, detachable: true, windowTitle: "Starred" },
  insights: { inline: true, detachable: true, windowTitle: "Insights" },
} as const satisfies Record<string, BuiltinViewSpec>;

export type BuiltinViewKey = keyof typeof BUILTIN_VIEWS;

/** Built-ins that may be the main window's `activeView`. */
type InlineBuiltinViewKey = {
  [K in BuiltinViewKey]: (typeof BUILTIN_VIEWS)[K]["inline"] extends true ? K : never;
}[BuiltinViewKey];

/** Built-ins that may be opened as their own window. */
type DetachableBuiltinViewKey = {
  [K in BuiltinViewKey]: (typeof BUILTIN_VIEWS)[K]["detachable"] extends true ? K : never;
}[BuiltinViewKey];

export type PluginViewKey = `plugin:${string}:${string}`;
type McpAppViewKey = `mcp-app:${string}:${string}`;

/** Anything the main window can render as `activeView`. MCP-app cards are
 *  detach-only, so they are absent by construction rather than by convention. */
export type InlineViewKey = InlineBuiltinViewKey | PluginViewKey;

/** Anything the detach IPC accepts. */
export type DetachableViewKey = DetachableBuiltinViewKey | PluginViewKey | McpAppViewKey;

/**
 * Two different questions get two different charsets, deliberately.
 *
 * PARSING asks what a key IS, and must accept everything the app can legally
 * produce. A plugin id is schema-constrained (`^[a-z][a-z0-9-]*$`), but a UI
 * extension id is declared as a bare `string` in
 * `schemas/plugin-manifest.schema.json` — so `plugin:my-plugin:MainView` is a
 * valid, shipping key. Parsing therefore asserts STRUCTURE only: a non-empty
 * segment is anything without a colon, since the colon is what separates them.
 *
 * The DETACH ALLOW-LIST asks what may open a window, which is an input check on
 * an IPC boundary. It stays exactly as strict as it has always been.
 * The two are not the same set, and pretending otherwise would either loosen a
 * security boundary or break plugins that work today: a `MainView` extension
 * renders inline right now and has never been able to detach.
 */
const STRUCTURAL_SEGMENT_RE = /^[^:]+$/;
/** The historical detach charset — lowercase, dots/underscores/hyphens. */
const STRICT_SEGMENT = "[a-z0-9][a-z0-9_.-]*";
/** `mcp-app` server ids are hex-encoded UTF-8 (see `mcp-app-partition.ts`). */
const HEX_SEGMENT = "[0-9a-f]+";

/** Built-in keys that may be detached, in a stable order. */
const DETACHABLE_BUILTIN_VIEW_KEYS: readonly DetachableBuiltinViewKey[] =
  (Object.keys(BUILTIN_VIEWS) as BuiltinViewKey[])
    .filter((key): key is DetachableBuiltinViewKey => BUILTIN_VIEWS[key].detachable)
    .sort();

/**
 * The detach allow-list, derived from the table rather than restated. The main
 * process validates every incoming `openDetached(viewKey)` against this.
 */
export const DETACHABLE_VIEW_KEY_PATTERN = new RegExp(
  `^(${DETACHABLE_BUILTIN_VIEW_KEYS.join("|")}`
    + `|plugin:${STRICT_SEGMENT}:${STRICT_SEGMENT}`
    + `|mcp-app:${HEX_SEGMENT}:${STRICT_SEGMENT})$`,
);

/** A view key taken apart. `null` from `parseViewKey` means "not a view key". */
export type ParsedViewKey =
  | { kind: "builtin"; key: BuiltinViewKey }
  | { kind: "plugin"; key: PluginViewKey; pluginId: string; viewId: string }
  | { kind: "mcp-app"; key: McpAppViewKey; serverIdHex: string; cardId: string };

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

  if (raw.startsWith("mcp-app:")) {
    const rest = raw.slice("mcp-app:".length);
    const separator = rest.indexOf(":");
    if (separator <= 0) return null;
    const serverIdHex = rest.slice(0, separator);
    const cardId = rest.slice(separator + 1);
    if (!/^[0-9a-f]+$/.test(serverIdHex) || !STRUCTURAL_SEGMENT_RE.test(cardId)) return null;
    return { kind: "mcp-app", key: raw as McpAppViewKey, serverIdHex, cardId };
  }

  return null;
}

/** Build a plugin view key. The only place this shape is spelled out. */
export function pluginViewKey(pluginId: string, viewId: string): PluginViewKey {
  return `plugin:${pluginId}:${viewId}`;
}

/** True when `raw` can be the main window's `activeView`. */
export function isInlineViewKey(raw: string): raw is InlineViewKey {
  const parsed = parseViewKey(raw);
  if (!parsed) return false;
  if (parsed.kind === "builtin") return BUILTIN_VIEWS[parsed.key].inline;
  return parsed.kind === "plugin";
}

/**
 * True when `raw` may be opened as its own window — the check the main process
 * applies to the detach IPC. Stricter than `parseViewKey` on purpose: see the
 * charset note above.
 */
export function isDetachableViewKey(raw: string): raw is DetachableViewKey {
  return DETACHABLE_VIEW_KEY_PATTERN.test(raw);
}

/** OS window title for a detached built-in, or `null` for namespaced keys
 *  (whose titles come from the plugin/card metadata instead). */
export function detachedWindowTitle(raw: string): string | null {
  const parsed = parseViewKey(raw);
  if (parsed?.kind !== "builtin") return null;
  const spec: BuiltinViewSpec = BUILTIN_VIEWS[parsed.key];
  return spec.windowTitle ?? null;
}

/** A view key that the main window can actually be AT. */
export type ParsedInlineViewKey =
  | { kind: "builtin"; key: InlineBuiltinViewKey }
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
  if (parsed.kind !== "builtin") return null;
  const spec: BuiltinViewSpec = BUILTIN_VIEWS[parsed.key];
  if (!spec.inline) return null;
  return { kind: "builtin", key: parsed.key as InlineBuiltinViewKey };
}
