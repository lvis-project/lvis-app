/**
 * Gate 4 — runtime-state admission. The ONE authority for "may this plugin do
 * anything at all right now".
 *
 * Two production entry points ask it: the loopback `tools/call` delegate
 * (`src/mcp/plugin-runtime-delegate.ts`) and card serving
 * (`PluginRuntime.readUiResource`). They used to spell the predicate out by
 * hand, expression for expression, linked only by a comment — so either copy
 * could drift and admit what the other refuses. Callers now format their own
 * surface-shaped message from the returned reason and MUST NOT re-derive it.
 */
import { manifestIntegrityState } from "../../permissions/manifest-integrity.js";
import { sessionContext } from "../../engine/session-context.js";

/**
 * Why {@link checkRuntimeAdmission} refused. `null` — not a member of this
 * union — means admitted.
 */
export type PluginRuntimeAdmissionRefusal = "inactive" | "integrity-disabled";

/** The runtime state Gate 4 reads. `PluginRuntime` satisfies it structurally. */
export interface PluginRuntimeAdmissionState {
  isPluginEnabled(pluginId: string): boolean;
  isSessionActivated(sessionId: string, pluginId: string): boolean;
}

/**
 * Admit the plugin when it is registry-enabled OR session-activated for the
 * CALLING session, and not manifest-integrity-disabled.
 *
 * Session activation is set by ConversationLoop after `request_plugin` clears
 * the allow-list gate in a routine session — it is NEVER persistent
 * (`setPluginEnabled` is not called; the registry stays `enabled:false`). The
 * calling session ID is read from AsyncLocalStorage (set by
 * `ConversationLoop.runTurn` around `this.queryLoop`); per-session scoping
 * guarantees that clearing session B never wipes session A's activation.
 *
 * Fail-closed: with no session context (e.g. an out-of-band call from tests
 * without ALS context) `sessionId` is undefined and the gate refuses.
 */
export function checkRuntimeAdmission(
  runtime: PluginRuntimeAdmissionState,
  pluginId: string,
): PluginRuntimeAdmissionRefusal | null {
  const sessionId = sessionContext.getStore()?.sessionId;
  if (
    !runtime.isPluginEnabled(pluginId) &&
    !(sessionId !== undefined && runtime.isSessionActivated(sessionId, pluginId))
  ) {
    return "inactive";
  }
  if (manifestIntegrityState.isDisabled(pluginId)) return "integrity-disabled";
  return null;
}
