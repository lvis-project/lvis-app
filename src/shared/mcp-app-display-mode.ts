/**
 * MCP Apps display mode — the host's SoT for `ui/request-display-mode`.
 *
 * The spec's vocabulary is `inline | fullscreen | pip`, but a host only supports what
 * its window plumbing actually gives it, and it must advertise exactly that. This
 * module owns BOTH halves so they cannot drift:
 *
 *   · `MCP_APP_AVAILABLE_DISPLAY_MODES` — what the host advertises in the
 *     `McpUiHostContext` (`availableDisplayModes`), and
 *   · `isSupportedMcpAppDisplayMode` — the ONE predicate the `onrequestdisplaymode`
 *     handler applies to an incoming request.
 *
 * ─── Why `pip` is now advertised ─────────────────────────────────────────────
 * `pip` used to be excluded here because LVIS had no second, coexisting live surface
 * for a card to move into: the detached shell is a SINGLE-INSTANCE window
 * (`WindowManager._detachedShell`, Path A policy) — at most one exists, and opening
 * another view navigates it rather than spawning a second one. That reasoning is now
 * OBSOLETE: a card's location is owned by a renderer-side location authority
 * (`ui/renderer/state/mcp-app-card-location-store.ts`) that tracks exactly ONE live
 * mount per card across THREE possible locations — `inline`, `pip`, `detached` — and
 * atomically moves a card between them, so a `pip` presentation can coexist with the
 * detached shell without a second copy of a card ever being live at once. Advertising
 * `pip` here is what makes that third location reachable from an app; WHICH component
 * actually renders it is a presentation choice the location authority itself does not
 * depend on, and today that component is `McpAppPipPanel` — an in-page draggable panel
 * (`ui/renderer/components/McpAppPipPanel.tsx`, mounted in `MainContent`) that
 * subscribes to the store's pip slot. `applyDisplayMode` does NOT decline a `pip`
 * request: it `moveCard`s the card into the store's `pip` slot and returns `"pip"`,
 * the panel picks it up and mounts a live `<McpAppView>`, and the losing mount goes
 * dormant — the same replace-not-clone move every other mode change makes.
 *
 * The mapping for all three advertised modes:
 *   · `inline`     — the in-transcript <webview> card (the default every card mounts in)
 *   · `fullscreen` — the MAXIMIZED detached shell, on the existing detach seam
 *                    (`CHANNELS.mcp.openDetached` → `WindowManager.openDetachedMcpApp`)
 *   · `pip`        — the in-page `McpAppPipPanel`, via the renderer-side location store
 *                    (no window plumbing — it is a sibling mount in the same renderer)
 */

/**
 * @see ext-apps `McpUiDisplayMode` — a local twin, for the same drift-safety /
 * portability reason `mcp-app-host-context.ts` re-declares its standard types: this
 * module is imported by the React-free renderer bridge, by the main process, and by
 * the e2e page bundle, and none of them should have to resolve the package's
 * extensionless `.d.ts` chain to name a three-member string union.
 */
export type McpUiDisplayMode = "inline" | "fullscreen" | "pip";

/** Every card mounts inline; it is also the answer to an unavailable-mode request. */
export const MCP_APP_DEFAULT_DISPLAY_MODE: McpUiDisplayMode = "inline";

/**
 * The modes this host can actually apply — advertised verbatim as the host context's
 * `availableDisplayModes`, and the allow-list the handler checks a request against.
 */
export const MCP_APP_AVAILABLE_DISPLAY_MODES: readonly McpUiDisplayMode[] = [
  "inline",
  "fullscreen",
  "pip",
];

/** The ONE membership test for an app-requested mode. */
export function isSupportedMcpAppDisplayMode(mode: unknown): mode is McpUiDisplayMode {
  return (
    typeof mode === "string" &&
    (MCP_APP_AVAILABLE_DISPLAY_MODES as readonly string[]).includes(mode)
  );
}
