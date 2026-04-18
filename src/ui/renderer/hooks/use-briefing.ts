import { useCallback, useEffect, useRef, useState } from "react";
import type { BriefingPayload, LvisApi } from "../types.js";

/**
 * Phase 3.3 — briefing state hook.
 *
 * Owns: proactive briefing payload state, the onProactiveBriefing IPC
 * subscription, and the dismiss / snooze callbacks. Mirrors the prior
 * behavior in App (renderer.tsx) including debounce-respecting result
 * handling (hide only on ok:true) and warn-on-failure.
 */
export function useBriefing(api: LvisApi) {
  const [briefing, setBriefing] = useState<BriefingPayload | null>(null);
  // aliveRef — guards late setBriefing(null) from dismiss/snooze promises that
  // resolve after unmount. See Copilot HIGH #3.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const unsubscribe = api.onProactiveBriefing((b) => {
      if (aliveRef.current) setBriefing(b);
    });
    return () => {
      aliveRef.current = false;
      unsubscribe();
    };
  }, [api]);

  const dismiss = useCallback(
    (feedback?: { reason: string; details?: string }) => {
      void api.dismissBriefing(feedback).then((r) => {
        if (!aliveRef.current) return;
        if (r?.ok) setBriefing(null);
        else console.warn("[lvis] dismissBriefing skipped:", r);
      }).catch((e: Error) => {
        console.warn("[lvis] dismissBriefing failed:", e.message);
      });
    },
    [api],
  );

  const snooze = useCallback(() => {
    void api.snoozeBriefing().then((r) => {
      if (!aliveRef.current) return;
      if (r?.ok) setBriefing(null);
      else console.warn("[lvis] snoozeBriefing skipped:", r);
    }).catch((e: Error) => {
      console.warn("[lvis] snoozeBriefing failed:", e.message);
    });
  }, [api]);

  return { briefing, dismiss, snooze };
}
