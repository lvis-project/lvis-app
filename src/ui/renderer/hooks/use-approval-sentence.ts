import { useCallback, useEffect, useRef, useState } from "react";
import { formatIpcError } from "../format-ipc-error.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";

/**
 * `/allow <sentence>` — issue #1940.
 *
 * The composer is the submit gesture. When an approval is pending, the turn is
 * suspended inside the tool call, so anything typed would otherwise land in the
 * mid-turn message queue and be delivered to the model much later. `/allow`
 * is therefore intercepted here, before the queue, and answered by the host.
 *
 * What comes back is a scope to PRE-SELECT. It moves focus onto one of the
 * buttons the approval card is already rendering; the user still presses it.
 * The sentence fills the form, the button grants — that separation is the whole
 * design, and it is why nothing in this file can call `decide`.
 *
 * Every other outcome (no pending prompt, no provider, no clear match, a
 * malformed or failed selection) becomes one plain sentence routed to
 * `onNotice`. `formatIpcError` maps the host's kebab-case code to localized
 * text, so a failure can never surface as a raw code and never as anything
 * shaped like an approval.
 */

const ALLOW_PREFIX = "/allow";

/** Cheap, local recognition. The host re-parses authoritatively. */
export function isApprovalSentenceInput(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === ALLOW_PREFIX || trimmed.startsWith(`${ALLOW_PREFIX} `);
}

export interface UseApprovalSentenceOptions {
  approvalRequest: ApprovalRequest | null;
  /** Sink for the plain user-facing sentence. Never receives a grant. */
  onNotice?: (message: string) => void;
}

export function useApprovalSentence({
  approvalRequest,
  onNotice,
}: UseApprovalSentenceOptions) {
  const [proposedChoice, setProposedChoice] = useState<ApprovalChoice | null>(null);
  const requestId = approvalRequest?.id ?? null;
  const requestIdRef = useRef<string | null>(null);
  requestIdRef.current = requestId;

  // A proposal belongs to exactly one prompt. A new request — or the prompt
  // being answered — drops it, so a stale proposal can never pre-select a
  // button on a request it was not about.
  useEffect(() => {
    setProposedChoice(null);
  }, [requestId]);

  const notice = useCallback(
    (error: string) => onNotice?.(formatIpcError(error, undefined)),
    [onNotice],
  );

  /**
   * Returns true when the input was an approval sentence and has been handled
   * (so the caller must not also send it as a chat message).
   */
  const interceptSubmit = useCallback(
    (text: string): boolean => {
      if (!isApprovalSentenceInput(text)) return false;
      const pendingId = requestIdRef.current;
      if (!pendingId) {
        notice("allow-no-pending-request");
        return true;
      }
      const api = window.lvis?.approval;
      if (!api?.selectSentence) {
        notice("allow-selector-unavailable");
        return true;
      }
      void (async () => {
        try {
          const result = await api.selectSentence(pendingId, text.trim());
          // The prompt may have been answered or replaced while the selector
          // was thinking. Landing a proposal on whatever is on screen now
          // would pre-select a button for a different request.
          if (requestIdRef.current !== pendingId) return;
          if (result?.ok) {
            setProposedChoice(result.choice);
            return;
          }
          notice(result?.error ?? "allow-selection-failed");
        } catch {
          notice("allow-selection-failed");
        }
      })();
      return true;
    },
    [notice],
  );

  return { proposedChoice, interceptSubmit };
}
