/**
 * `onmessage` handler — the app asked for its message to reach the user (`ui/message`).
 *
 * This module decides NOTHING. It proxies the request to the host's gated
 * `CHANNELS.mcp.uiMessage` IPC (via the injected `postMessage`, which McpAppView binds
 * to the CARD's `serverId` AND the card's origin session id) and shapes the answer into
 * the spec's `McpUiMessageResult`. Three consequences worth naming:
 *
 *  - The app names neither a server nor a conversation. Both bindings come from the
 *    trusted renderer, so a compromised app can reach neither another server's card nor
 *    a session the user has navigated away from (main re-checks the session against the
 *    live loop and falls back to a notification on mismatch).
 *  - The host's TURN POLICY runs in main, not here: notification meta → the popup
 *    surface; an active turn → round-boundary guidance; no active turn → a user-gated
 *    staging card. The app never learns which happened beyond accept/reject — and it
 *    can never autonomously wake the model.
 *  - The result is `{ isError?: boolean }` and NOTHING else. The type itself forbids
 *    echoing conversation content back to the app, which is the spec's explicit MUST NOT.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiMessageOutcome } from "../../../../../mcp/mcp-ui-message.js";

/** The `onmessage` request callback shape, derived from the installed `AppBridge`. */
export type OnMessage = NonNullable<AppBridge["onmessage"]>;

/** The `McpUiMessageResult` this handler returns (spec shape, derived off the bridge). */
type McpUiMessageResult = Awaited<ReturnType<OnMessage>>;

export interface OnMessageDeps {
  /**
   * Deliver the app's `ui/message` params through the host's gated IPC. Already bound
   * to the card's `serverId` + origin session id by McpAppView — this handler cannot
   * choose either. Resolves to an outcome; `{ ok: false }` is a host rejection.
   */
  postMessage(params: unknown): Promise<McpUiMessageOutcome>;
}

export function createOnMessage({ postMessage }: OnMessageDeps): OnMessage {
  return async (params) => {
    try {
      const outcome = await postMessage(params);
      // Accept → `{}`. Reject → `{ isError: true }`. No content, no reason: the app is
      // told whether the host took it, never what the conversation contains.
      return outcome.ok ? {} : ({ isError: true } satisfies McpUiMessageResult);
    } catch {
      // The IPC itself failed (transport / unauthorized frame). Still an error RESULT,
      // never a rejected bridge request.
      return { isError: true } satisfies McpUiMessageResult;
    }
  };
}
