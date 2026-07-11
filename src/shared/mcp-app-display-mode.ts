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
 * ─── Why no `pip` ────────────────────────────────────────────────────────────
 * LVIS's detached surface is a SINGLE-INSTANCE shell (`WindowManager._detachedShell`,
 * Path A policy): at most one detached BrowserWindow exists, and opening another view
 * navigates it rather than spawning a second one. A picture-in-picture card is a
 * small, always-on-top window that must COEXIST with whatever else is detached — a
 * second window stack with its own always-on-top plumbing. That is a new window
 * subsystem, not a reuse of the existing one, so `pip` is deliberately NOT advertised
 * and a `pip` request is answered with the card's current mode (the spec's prescribed
 * response for an unavailable mode).
 *
 * The mapping for the two modes that ARE advertised, both on the existing detach seam
 * (`CHANNELS.mcp.openDetached` → `WindowManager.openDetachedMcpApp`):
 *   · `inline`     — the in-transcript <webview> card (the default every card mounts in)
 *   · `fullscreen` — the MAXIMIZED detached shell
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
];

/** The ONE membership test for an app-requested mode. */
export function isSupportedMcpAppDisplayMode(mode: unknown): mode is McpUiDisplayMode {
  return (
    typeof mode === "string" &&
    (MCP_APP_AVAILABLE_DISPLAY_MODES as readonly string[]).includes(mode)
  );
}
