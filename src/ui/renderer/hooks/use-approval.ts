import { useCallback, useEffect, useRef, useState } from "react";
import { approvalQueueReducer } from "../../../lib/approval-queue-reducer.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";

/**
 * Phase 3.4 — approval queue hook.
 *
 * Owns: FIFO approval queue state (via approvalQueueReducer), the
 * window.lvis.approval.onRequest subscription, and the decide handler which
 * shifts the queue before responding so the next pending request surfaces
 * immediately. Mirrors the prior behavior in App (renderer.tsx) §C4.
 */
export function useApproval() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  const queueRef = useRef<ApprovalRequest[]>([]);
  // In-flight guard — prevents double-click from dropping the pending item
  // between shift() and respond(). See Copilot HIGH #2.
  const inFlightRef = useRef<boolean>(false);
  // Fix 5 (PR #97) — aliveRef symmetry with use-briefing: guard late setQueue
  // from async `respond()` callbacks resolving after unmount.
  const aliveRef = useRef(true);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    aliveRef.current = true;
    if (!window.lvis?.approval) {
      return () => {
        aliveRef.current = false;
      };
    }
    const unsub = window.lvis.approval.onRequest((req) => {
      if (!aliveRef.current) return;
      setQueue((q) => approvalQueueReducer(q, { type: "push", req }));
    });
    return () => {
      aliveRef.current = false;
      unsub();
    };
  }, []);

  /**
   * Decide the currently-pending approval request.
   *
   * On `respond()` rejection we only log — we do NOT re-push the request onto
   * the queue. The main process has likely already emitted a response (or the
   * request is no longer actionable), and re-pushing causes a double-display
   * bug where the user sees the same modal twice. See Fix 5 (PR #97).
   */
  const decide = useCallback(
    async (choice: ApprovalChoice, pattern?: string) => {
      if (inFlightRef.current) return;
      const current = queueRef.current[0];
      if (!current) return;
      inFlightRef.current = true;
      // shift 먼저 — respond 완료 전에 다음 항목 표시
      setQueue((q) => approvalQueueReducer(q, { type: "shift" }));
      try {
        if (window.lvis?.approval) {
          await window.lvis.approval.respond({
            requestId: current.id,
            choice,
            rememberPattern: pattern,
            // §D2: echo nonce + HMAC verbatim so the main process can verify
            // this response was bound to the original request (confused-
            // deputy defense). Stale or cross-wired responses fail the check
            // and are forcibly downgraded to deny-once.
            nonce: current.nonce,
            hmac: current.hmac,
          });
        }
      } catch (err) {
        // Log only — do NOT re-push. See JSDoc above.
        console.warn("[lvis] approval.respond failed:", (err as Error).message);
      } finally {
        inFlightRef.current = false;
      }
    },
    [],
  );

  return { queue, decide };
}
