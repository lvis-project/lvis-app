/**
 * MCP Apps display mode — the host's SoT for `ui/request-display-mode`.
 *
 * The spec's vocabulary is `inline | fullscreen | pip`, but a host only supports what
 * it has a surface for, and it must advertise exactly that. This module owns BOTH
 * halves so they cannot drift:
 *
 *   · `MCP_APP_AVAILABLE_DISPLAY_MODES` — what the host advertises in the
 *     `McpUiHostContext` (`availableDisplayModes`), and
 *   · `isSupportedMcpAppDisplayMode` — the ONE predicate the `onrequestdisplaymode`
 *     handler applies to an incoming request.
 *
 * ─── Why all three spec modes are advertised ─────────────────────────────────
 * A card's location is owned by a renderer-side location authority
 * (`ui/renderer/state/mcp-app-card-location-store.ts`) that tracks exactly ONE live
 * mount per card across THREE locations — `inline`, `pip`, `fullscreen` — and
 * atomically moves a card between them. Every away location is a SINGLE-OCCUPANT slot
 * with one component subscribed to it, so no mode can ever produce a second live copy
 * of a card. `applyDisplayMode` declines nothing that is advertised here: it `moveCard`s
 * the card into the requested slot and returns that mode, the slot's panel picks it up
 * and mounts a live `<McpAppView>`, and the losing mount goes dormant — the same
 * replace-not-clone move every mode change makes.
 *
 * The mapping for all three advertised modes:
 *   · `inline`     — the in-transcript <webview> card (the default every card mounts in)
 *   · `fullscreen` — `McpAppFullscreenPanel`, an in-renderer surface that takes over the
 *                    window's content area
 *   · `pip`        — `McpAppPipPanel`, an in-renderer draggable floating panel
 *
 * ─── Why `fullscreen` is not a second window ─────────────────────────────────
 * The confirmed MCP Apps revision gives `fullscreen` no normative definition at all; it
 * defines only `inline` ("embedded within the host's content flow") and `pip`
 * ("floating overlay"). The draft that adds `fullscreen` describes the view as TAKING
 * OVER the full screen/window — a claim about occupied surface, not about spawning a
 * new one. The ext-apps SDK's own documented example toggles a CSS class on the app's
 * existing container, and the reference host implements it as an inline↔fullscreen
 * panel toggle on the same iframe. Both away modes therefore live in the renderer, and
 * neither needs window plumbing.
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
