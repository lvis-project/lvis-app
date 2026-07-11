/**
 * `onrequestdisplaymode` handler — the app asked to be presented differently
 * (`ui/request-display-mode`).
 *
 * The default `AppBridge` behaviour is to ECHO the host context's `displayMode` back,
 * which means a host that leaves this unset silently ignores every request while
 * appearing to answer it. Registering the handler is what makes the mode real, and the
 * contract is precise: return the mode ACTUALLY APPLIED, which is the current one when
 * the request cannot be honoured.
 *
 * Exactly one rule lives here, and it lives ONLY here: a requested mode is honoured iff
 * it is in the host's advertised set (`MCP_APP_AVAILABLE_DISPLAY_MODES` — the same SoT
 * McpAppView publishes as the host context's `availableDisplayModes`, so what the app
 * is told it may ask for and what the host will accept can never disagree). Anything
 * else — today `pip`, tomorrow any mode a future spec adds — resolves to the card's
 * current mode. No throw: an unavailable mode is a normal, expected answer.
 *
 * The APPLY itself is McpAppView's (it owns the card's surface: the in-transcript
 * <webview> and the host's existing detach seam). This module never touches a window.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  isSupportedMcpAppDisplayMode,
  type McpUiDisplayMode,
} from "../../../../../shared/mcp-app-display-mode.js";

/** The `onrequestdisplaymode` request callback shape, derived from the installed `AppBridge`. */
export type OnRequestDisplayMode = NonNullable<AppBridge["onrequestdisplaymode"]>;

export interface OnRequestDisplayModeDeps {
  /** The card's CURRENT display mode, read at call time (McpAppView owns the state). */
  getMode(): McpUiDisplayMode;
  /**
   * Apply a SUPPORTED mode to this card's surface. Resolves to the mode actually
   * applied — which is the previous one when the host declined (e.g. the detached
   * window could not be opened). Never called for an unsupported mode.
   */
  applyMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode>;
}

export function createOnRequestDisplayMode(
  { getMode, applyMode }: OnRequestDisplayModeDeps,
): OnRequestDisplayMode {
  return async ({ mode }) => {
    // Not advertised ⇒ not applied. Answer with the mode the card is actually in.
    if (!isSupportedMcpAppDisplayMode(mode)) return { mode: getMode() };
    try {
      return { mode: await applyMode(mode) };
    } catch {
      // The apply path failed (IPC transport / unauthorized frame throw). The card did
      // not move, so the truthful answer is the mode it is still in.
      return { mode: getMode() };
    }
  };
}
