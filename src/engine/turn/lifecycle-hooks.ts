/**
 * Script-hook lifecycle dispatch helpers.
 *
 * `fireLifecycleEvent` (NON-BLOCKING, observe-only, fail-soft) and
 * `fireUserPromptSubmit` (BLOCKING, FAIL-CLOSED). Extracted verbatim from
 * `conversation-loop.ts`; fail-closed / fail-soft semantics are unchanged.
 */
import type { LifecycleHookEvent } from "../../hooks/script-hook-types.js";
import type { ConversationLoopDeps } from "./types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("lvis");

export async function fireLifecycleEvent(
  deps: ConversationLoopDeps,
  sessionId: string,
  event: LifecycleHookEvent,
  payload: import("../../hooks/script-hook-manager.js").LifecycleEventPayload = {},
  sessionIdOverride?: string,
): Promise<void> {
    const manager = deps.scriptHookManager;
    if (!manager) return;
    try {
      await manager.runLifecycleEvent(
        event,
        sessionIdOverride ?? sessionId,
        // Lifecycle events are session-scoped, not tied to a single user input;
        // attribute to the canonical "unknown" hook origin like other
        // non-user-keyboard dispatches (no enrollment/mutation path here).
        "unknown",
        payload,
      );
    } catch (err) {
      log.warn(
        `lifecycle event ${event} dispatch failed (non-blocking, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
}

export async function fireUserPromptSubmit(
  deps: ConversationLoopDeps,
  sessionId: string,
  payload: import("../../hooks/script-hook-manager.js").UserPromptSubmitPayload,
  sessionIdOverride?: string,
): Promise<{ decision: "allow" | "deny"; reason: string }> {
    const manager = deps.scriptHookManager;
    // No manager ⇒ no hooks.json ⇒ proceed exactly as today.
    if (!manager) return { decision: "allow", reason: "no script hook manager" };
    try {
      const result = await manager.runUserPromptSubmit(
        sessionIdOverride ?? sessionId,
        // The prompt's input origin is propagated into the payload; for the
        // hook trustOrigin we attribute to "unknown" like other non-keyboard
        // dispatches (no enrollment/mutation path through this event).
        "unknown",
        payload,
      );
      return { decision: result.decision, reason: result.reason };
    } catch (err) {
      // FAIL-CLOSED: a blocking event must DENY on an unexpected error — the
      // turn is refused rather than silently allowed.
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `UserPromptSubmit dispatch threw — failing closed (deny): ${message}`,
      );
      return {
        decision: "deny",
        reason: `UserPromptSubmit dispatch error (fail-closed → deny): ${message}`,
      };
    }
}
