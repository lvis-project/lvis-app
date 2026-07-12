/**
 * The host-owned record behind ONE detached MCP-app card (#885 b2).
 *
 * A detached card is not just its `McpUiPayload`. It also carries the CHAT SESSION it
 * was detached FROM, because a card's session is one of the three bindings every
 * app→host write is checked against (`ui/message`, `ui/update-model-context`). The
 * inline card gets that binding from the renderer's `ChatContext`; the detached window
 * has no `ChatContextProvider` in its React root, so without this field a detached card
 * would post `sessionId: ""`, main would drop every update on the session check, and the
 * app — whose `ui/update-model-context` has no error channel in the spec — would never
 * learn. It would advertise a capability that silently does nothing, forever.
 *
 * The session id is therefore MINTED BY THE HOST AT DETACH TIME (the trusted renderer's
 * latched origin session, validated in `WindowManager`'s open-detached handler and stored
 * HERE, outside the `McpUiPayload`) — never named by the app, and never carried on the
 * tool result's `_meta.ui`. Keeping it a sibling of `payload` rather than a field ON it is
 * what makes that structural: an MCP server cannot smuggle a session id through a type it
 * does not populate.
 *
 * It is a BINDING, not an authorization: main re-checks it against the live conversation
 * on every use, exactly as the inline path does, so a card detached from a session the
 * user has since left still cannot write into the session they are in now.
 */
import type { McpUiPayload } from "../mcp/types.js";

export interface McpAppDetachedPayload {
  /** The card itself — the same payload the inline transcript card renders. */
  payload: McpUiPayload;
  /**
   * The chat session the card was detached from, or `""` when it was detached from a
   * surface with no session. `""` is not a session id, so it never matches the live
   * one: the fail-safe branch, identical to the inline path's empty binding.
   */
  originSessionId: string;
}

/**
 * Session ids are host-minted `[A-Za-z0-9_-]` tokens (the same charset
 * `lvis:window:load-session-in-main` validates). Anything else — a non-string, a path,
 * an over-long blob — degrades to `""`, which can only ever FAIL the session check.
 * Fail-closed by construction: the worst case is a card whose writes are dropped.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function sanitizeMcpAppOriginSessionId(value: unknown): string {
  return typeof value === "string" && SESSION_ID_RE.test(value) ? value : "";
}
