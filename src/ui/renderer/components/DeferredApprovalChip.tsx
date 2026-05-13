/**
 * Issue #690 P4 — natural-language approval intent chip.
 *
 * What this renders:
 *   When the user has typed an approval/rejection phrase in the chat
 *   composer AND exactly ONE deferred-queue entry is pending, this
 *   chip surfaces above the composer with the matched intent and two
 *   buttons: [허용] / [거절]. Clicking either calls
 *   `permission.deferredResolve` with `approvalSource: "natural-language"`,
 *   and the audit row records the matched phrase as `reason`.
 *
 * What this DOES NOT do:
 *   - Auto-resolve. The user must click. The matcher only suggests;
 *     a stray "허용" typed into chat never approves a pending entry
 *     unsupervised.
 *   - Resolve when multiple entries pend. Ambiguous targeting would
 *     be a footgun (#690 spec: 1회성 승인 — single target). The user
 *     must use the DeferredQueuePanel for multi-entry triage.
 *   - Trigger on text shorter than 1 char, longer than the matcher's
 *     cap (40 chars), or with sentence breaks — that's enforced inside
 *     {@link detectApprovalIntent}.
 *
 * Bind: this component subscribes to `permission.deferredList` /
 * `permission.onDeferredPending` itself; ChatView only passes the
 * draft text down.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import {
  detectApprovalIntent,
  type ApprovalIntent,
} from "../../../permissions/approval-intent.js";
import type { DeferredQueueEntry } from "../types.js";

export interface DeferredApprovalChipProps {
  /** The user's current composer draft text. Re-evaluated on every change. */
  draftText: string;
  /** Optional callback the parent can use to log telemetry / surface errors. */
  onResolved?: (decision: "approved" | "rejected", entryId: string) => void;
}

export function DeferredApprovalChip({
  draftText,
  onResolved,
}: DeferredApprovalChipProps) {
  const [pending, setPending] = useState<DeferredQueueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = window.lvis?.permission?.deferredList;
    if (!api) {
      setPending([]);
      return;
    }
    try {
      const r = await api();
      if (r.ok) {
        setPending(r.pending);
      }
    } catch {
      // Silent — the chip is a UX accelerator; refresh failures
      // simply mean the chip stays hidden. The panel surface remains
      // the authoritative path.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const sub = window.lvis?.permission?.onDeferredPending?.(() => {
      void refresh();
    });
    return () => sub?.();
  }, [refresh]);

  const intent: ApprovalIntent = detectApprovalIntent(draftText);

  // Hard gate: chip only renders when the matcher fires AND exactly
  // one entry is pending. Anything else → no chip (the panel surface
  // remains the authoritative path).
  if (intent.kind === "none") return null;
  if (pending.length !== 1) return null;

  const target = pending[0]!;
  const decision = intent.kind === "approve" ? "approved" : "rejected";

  const handle = async () => {
    if (busy) return;
    const api = window.lvis?.permission?.deferredResolve;
    if (!api) {
      setError("deferred-resolve API 사용 불가");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api(
        target.id,
        decision,
        `natural-language match: ${"matchedPhrase" in intent ? intent.matchedPhrase : "?"}`,
        "natural-language",
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onResolved?.(decision, target.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "deferred-resolve failed");
    } finally {
      setBusy(false);
    }
  };

  const label =
    intent.kind === "approve"
      ? `'${target.toolName}' 호출 허용?`
      : `'${target.toolName}' 호출 거절?`;
  const action = intent.kind === "approve" ? "허용" : "거절";

  return (
    <div
      data-testid="deferred-approval-chip"
      className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs"
    >
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full bg-primary"
      />
      <span className="flex-1 min-w-0">
        <span className="font-medium">승인 의도 감지: </span>
        <span className="text-muted-foreground">{label}</span>
      </span>
      <Button
        size="sm"
        variant={intent.kind === "approve" ? "default" : "secondary"}
        disabled={busy}
        onClick={() => void handle()}
        data-testid="deferred-approval-chip-action"
      >
        {action}
      </Button>
      {error ? (
        <span className="text-destructive" data-testid="deferred-approval-chip-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
