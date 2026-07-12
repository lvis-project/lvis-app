/**
 * `onupdatemodelcontext` handler — the app OVERWROTE the context it wants the model to
 * have on the next turn (`ui/update-model-context`).
 *
 * This module decides NOTHING. It proxies the request to the host's gated
 * `CHANNELS.mcp.uiModelContext` IPC (via the injected `updateModelContext`, which
 * McpAppView binds to the CARD's `serverId`, its origin session, and its card id) and
 * answers with an `EmptyResult`. Three consequences worth naming:
 *
 *  - The result is `{}` — ALWAYS. `McpUiUpdateModelContextRequest` has no error channel
 *    (the spec's result type is `EmptyResult`), so a host refusal — an over-cap body, a
 *    stale session — is an AUDIT fact, not a protocol one. We do not invent an `isError`
 *    the spec does not define, and we do not throw: a rejected bridge request would tell
 *    the app to retry a store it is never going to win.
 *  - It NEVER triggers a turn. That is not a rule this module enforces; it is a fact of
 *    the seam. Main writes the card's slot, and the slot is READ at the next prompt
 *    build. There is no push path to the conversation loop from here at all.
 *  - The app names neither a server, a conversation, nor a card. All three bindings come
 *    from the trusted renderer, so a compromised app cannot overwrite another card's
 *    context or speak into a conversation the user has navigated away from.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiModelContextOutcome } from "../../../../../mcp/mcp-app-model-context.js";

/** The `onupdatemodelcontext` request callback shape, derived from the installed `AppBridge`. */
export type OnUpdateModelContext = NonNullable<AppBridge["onupdatemodelcontext"]>;

/** The `EmptyResult` this handler returns (spec shape, derived off the bridge). */
type EmptyResult = Awaited<ReturnType<OnUpdateModelContext>>;

export interface OnUpdateModelContextDeps {
  /**
   * Hand the app's `ui/update-model-context` params to the host's gated IPC. Already
   * bound to the card's `serverId` + origin session id + card id by McpAppView — this
   * handler cannot choose any of them.
   */
  updateModelContext(params: unknown): Promise<McpUiModelContextOutcome>;
}

export function createOnUpdateModelContext(
  { updateModelContext }: OnUpdateModelContextDeps,
): OnUpdateModelContext {
  return async (params) => {
    try {
      await updateModelContext(params);
    } catch {
      // The IPC itself failed (transport / unauthorized frame throw). Still an empty
      // RESULT, never a rejected bridge request — see the header.
    }
    return {} satisfies EmptyResult;
  };
}
