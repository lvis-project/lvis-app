import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";

export type TriggerResult = {
  sessionId: string;
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  prompt: string;
  summary: string;
  completedAt: string;
};

/**
 * Brain — proactive trigger result hook.
 *
 * Subscribes to `lvis:trigger:completed` and surfaces the latest captured
 * trigger session. Two user actions:
 *   - dismiss(sessionId): drop the cached session (host clears its cache too).
 *   - importIntoChat(sessionId): host appends the trigger's messages to the
 *     active chat history; renderer hides the card, chat picks up the
 *     conversation as if the user had been in it the whole time.
 *
 * `silent` triggers are filtered out at the hook level — they should not
 * surface a card. Only `summary-only` and `user-visible` reach the UI.
 */
export function useTriggerResult(api: LvisApi) {
  const [triggerResult, setTriggerResult] = useState<TriggerResult | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const offCompleted = api.onTriggerCompleted((result) => {
      if (!aliveRef.current) return;
      if (result.visibility === "silent") return; // never surface silent triggers
      setTriggerResult(result);
    });
    return () => {
      aliveRef.current = false;
      offCompleted();
    };
  }, [api]);

  const dismiss = useCallback(
    async (sessionId: string) => {
      if (!aliveRef.current) return;
      // Optimistic UI clear; the IPC call is fire-and-forget for the renderer.
      setTriggerResult((current) =>
        current && current.sessionId === sessionId ? null : current,
      );
      try {
        await api.dismissTrigger(sessionId);
      } catch (err) {
        console.warn("[lvis] dismissTrigger failed:", (err as Error).message);
      }
    },
    [api],
  );

  const importIntoChat = useCallback(
    async (sessionId: string): Promise<{ ok: boolean; imported?: number; reason?: string }> => {
      if (!aliveRef.current) return { ok: false };
      try {
        const result = await api.importTrigger(sessionId);
        if (result.ok && aliveRef.current) {
          setTriggerResult((current) =>
            current && current.sessionId === sessionId ? null : current,
          );
        }
        // `error` from the IPC layer maps to `reason` in the hook contract.
        return { ok: result.ok, imported: result.imported, reason: result.reason ?? result.error };
      } catch (err) {
        console.warn("[lvis] importTrigger failed:", (err as Error).message);
        return { ok: false, reason: (err as Error).message };
      }
    },
    [api],
  );

  return { triggerResult, dismiss, importIntoChat };
}
