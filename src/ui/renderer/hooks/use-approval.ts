import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { approvalQueueReducer } from "../../../lib/approval-queue-reducer.js";
import type { ApprovalChoice, ApprovalDecision, ApprovalRequest } from "../types.js";

export type ApprovalDecisionExtras = Pick<ApprovalDecision, "elicitationContent">;

/**
 * Approval queue hook.
 *
 * Owns: FIFO approval queue state (via approvalQueueReducer), the
 * window.lvis.approval.onRequest subscription, and the decide handler which
 * keeps the current head visible until the main process acknowledges its
 * response. That makes every surfaced request actionable and preserves FIFO.
 */
export function useApproval() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  const queueRef = useRef<ApprovalRequest[]>([]);
  // In-flight guard — prevents double-clicks and prevents the next queue item
  // from becoming actionable until the current response is acknowledged.
  const inFlightRequestIdRef = useRef<string | null>(null);
  // Guard late setQueue from async `respond()` callbacks resolving after
  // unmount.
  const aliveRef = useRef(true);
  // A queued request becomes clickable as soon as its dock is committed.
  // Synchronize the imperative head-of-queue ref before paint so a fast
  // click cannot observe the previous (or empty) queue.
  useLayoutEffect(() => {
    queueRef.current = queue;
    if (
      inFlightRequestIdRef.current !== null &&
      queue[0]?.id !== inFlightRequestIdRef.current
    ) {
      // The acknowledged head has been shifted. The newly surfaced request
      // can now be decided without allowing a duplicate response for the
      // prior head during the commit boundary.
      inFlightRequestIdRef.current = null;
    }
  }, [queue]);

  useEffect(() => {
    aliveRef.current = true;
    // Surface preload init bugs explicitly. The approval queue is a
    // load-bearing UX path; silently no-op'ing here when `window.lvis` is
    // missing makes the bug present as "tools never resolve" instead of
    // "preload didn't run".
    if (!window.lvis) {
      console.error("[use-approval] window.lvis is undefined — preload missing or failed to load");
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
   * On `respond()` rejection we only log — we do NOT re-push the request.
   * The main process may already have emitted a response (or the request is
   * no longer actionable), and re-pushing causes a double-display bug.
   */
  const decide = useCallback(
    async (choice: ApprovalChoice, pattern?: string, extras?: ApprovalDecisionExtras) => {
      if (inFlightRequestIdRef.current !== null) return;
      const current = queueRef.current[0];
      if (!current) return;
      // Assert preload availability explicitly. If the user landed on this
      // code path with no preload, the queue would never surface a request
      // anyway; reaching here means the early-return safeguard exists in two
      // places and one of them is stale.
      if (!window.lvis) {
        console.error("[use-approval] decide: window.lvis is undefined — preload missing");
        return;
      }
      inFlightRequestIdRef.current = current.id;

      try {
        await window.lvis.approval.respond({
          requestId: current.id,
          choice,
          rememberPattern: pattern,
          // Confused-deputy defense: echo nonce + HMAC verbatim so the main process can verify
          // this response was bound to the original request (confused-
          // deputy defense). Stale or cross-wired responses fail the check
          // and are forcibly downgraded to deny-once.
          nonce: current.nonce,
          hmac: current.hmac,
          ...(extras && "elicitationContent" in extras
            ? { elicitationContent: extras.elicitationContent }
            : {}),
        });
      } catch (err) {
        // Log only — do NOT re-push. See JSDoc above.
        console.warn("[lvis] approval.respond failed:", (err as Error).message);
      } finally {
        // Keep the decided head mounted until the IPC request settles. If a
        // new request arrives meanwhile, showing it before this guard releases
        // would make its click look successful while being ignored.
        if (aliveRef.current) {
          setQueue((q) => approvalQueueReducer(q, { type: "shift" }));
        } else {
          inFlightRequestIdRef.current = null;
        }
      }
    },
    [],
  );

  return { queue, decide };
}
