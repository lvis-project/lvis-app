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
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    if (!window.lvis?.approval) return;
    const unsub = window.lvis.approval.onRequest((req) => {
      setQueue((q) => approvalQueueReducer(q, { type: "push", req }));
    });
    return unsub;
  }, []);

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
          });
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [],
  );

  return { queue, decide };
}
