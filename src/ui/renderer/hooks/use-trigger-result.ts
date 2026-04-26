import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";

export type TriggerResult = {
  sessionId: string;
  pluginId: string;
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
 * Single-slot policy: latest trigger replaces any previous one. When the
 * card is displaced, the previous session's host-side cache entry is
 * actively dismissed so a future stale-click can't import an orphan.
 *
 * Subscribed events:
 *   - completed → set as visible card (unless visibility==="silent")
 *   - failed     → clear matching card (renderer drops a UI it cannot
 *                  back — host already audited the classified reason)
 *   - expired    → host evicted the cached session under cache pressure;
 *                  clear matching card so accept-click won't 404
 *
 * `silent` visibility is filtered at the hook so the renderer never gets a
 * card; the host still audits + caches the session for potential debug.
 */
export function useTriggerResult(api: LvisApi) {
  const [triggerResult, setTriggerResult] = useState<TriggerResult | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const offCompleted = api.onTriggerCompleted((result) => {
      if (!aliveRef.current) return;
      if (result.visibility === "silent") return; // never surface silent triggers
      setTriggerResult((current) => {
        // Displaced session: actively dismiss its host-side cache entry so
        // a stale closure / late-firing button click can't resurrect it.
        if (current && current.sessionId !== result.sessionId) {
          void api.dismissTrigger(current.sessionId).catch(() => undefined);
        }
        return result;
      });
    });
    const offFailed = api.onTriggerFailed((payload) => {
      if (!aliveRef.current) return;
      setTriggerResult((current) =>
        current && current.sessionId === payload.sessionId ? null : current,
      );
    });
    const offExpired = api.onTriggerExpired((payload) => {
      if (!aliveRef.current) return;
      setTriggerResult((current) =>
        current && current.sessionId === payload.sessionId ? null : current,
      );
    });
    return () => {
      aliveRef.current = false;
      offCompleted();
      offFailed();
      offExpired();
    };
  }, [api]);

  const dismiss = useCallback(
    async (sessionId: string) => {
      if (!aliveRef.current) return;
      try {
        const result = await api.dismissTrigger(sessionId);
        if (!aliveRef.current) return;
        // Only clear UI state on confirmed success — if dismiss failed
        // (executor unavailable, kill-switch), keep the card so the user
        // sees the action didn't take effect.
        if (result.ok) {
          setTriggerResult((current) =>
            current && current.sessionId === sessionId ? null : current,
          );
        }
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
        if (!aliveRef.current) return result;
        if (result.ok) {
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
