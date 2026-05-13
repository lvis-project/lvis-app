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
 *     cap (24 chars), or with sentence breaks / question marks — that's
 *     enforced inside {@link detectApprovalIntent}.
 *
 * Bind: this component subscribes to `permission.deferredList` /
 * `permission.onDeferredPending` itself; ChatView only passes the
 * draft text down.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  // Round-2 code-reviewer MAJOR — synchronous re-entry guard. `useState`
  // updates batch + flush asynchronously in React 18, so a fast double
  // click could fire two `handle()` invocations before the first
  // `setBusy(true)` committed. A ref check that flips synchronously
  // closes the window.
  const inFlight = useRef(false);
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
    if (inFlight.current || busy) return;
    inFlight.current = true;
    const api = window.lvis?.permission?.deferredResolve;
    const listApi = window.lvis?.permission?.deferredList;
    if (!api) {
      inFlight.current = false;
      setError("deferred-resolve API 사용 불가");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Round-1 security MAJOR-1 (TOCTOU on pending[0]): re-fetch the
      // queue *at click time* and confirm (a) exactly one entry still
      // pending, (b) it is the same id we showed in the chip label.
      // Without this, a race that adds a new pending entry between
      // render and click would resolve the new entry instead.
      if (listApi) {
        const current = await listApi();
        if (!current.ok) {
          setError("pending 큐 확인 실패 — " + current.error);
          return;
        }
        if (current.pending.length !== 1 || current.pending[0]?.id !== target.id) {
          setError("pending 큐가 변경되었습니다 — 패널에서 직접 처리하세요");
          await refresh();
          return;
        }
      }
      // Round-1 critic MAJOR-4 (stale closure on intent): re-run the
      // matcher on the live draftText so the click can't act on an
      // intent that no longer reflects the composer.
      const liveIntent = detectApprovalIntent(draftText);
      if (liveIntent.kind !== intent.kind) {
        setError("의도가 변경되었습니다 — 입력 확인 후 다시 시도");
        return;
      }
      // Round-3 critic MAJOR — the audit `reason` field is HMAC-chained
      // tamper-evident storage. Passing the matched phrase verbatim
      // could land user-typed text (potentially PII / secrets adjacent
      // to the approve verb) in immutable forensic logs. The
      // `approvalSource: "natural-language"` field already carries
      // the provenance signal; the phrase itself adds no integrity
      // value, only PII risk. Use a static reason string.
      const r = await api(
        target.id,
        decision,
        "natural-language chip click",
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
      inFlight.current = false;
      setBusy(false);
    }
  };

  // Round-1 architect MAJOR-2 / round-2 code-reviewer MINOR — surface
  // the entry source so the user sees whether they're approving a
  // builtin host tool, a plugin tool, or an MCP-bridged tool. The
  // label is rendered with an aria-friendly source badge (see JSX
  // below) so screen readers announce "플러그인 도구" / "MCP 도구"
  // rather than the bracketed token.
  const sourceBadgeText =
    target.source === "plugin"
      ? "plugin"
      : target.source === "mcp"
        ? "mcp"
        : null;
  const sourceBadgeAriaLabel =
    target.source === "plugin"
      ? "플러그인 도구"
      : target.source === "mcp"
        ? "MCP 도구"
        : null;
  const labelTail =
    intent.kind === "approve"
      ? `'${target.toolName}' 호출 허용?`
      : `'${target.toolName}' 호출 거절?`;
  const action = intent.kind === "approve" ? "허용" : "거절";

  return (
    // Round-3 UX MAJOR — switched to `flex-col` so the error row drops
    // below the main row at narrow viewports instead of overflowing
    // beside the [허용]/[거절] button. The action row stays as a
    // horizontal flex inside.
    <div
      data-testid="deferred-approval-chip"
      data-target-id={target.id}
      data-target-source={target.source}
      className="mx-3 mb-2 flex flex-col gap-1 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-full bg-primary"
        />
        <span className="flex-1 min-w-0">
          <span className="font-medium">승인 의도 감지: </span>
          {sourceBadgeText && sourceBadgeAriaLabel ? (
            <span
              aria-label={sourceBadgeAriaLabel}
              className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px] uppercase text-muted-foreground"
            >
              <span aria-hidden="true">{sourceBadgeText}</span>
            </span>
          ) : null}
          <span className="text-muted-foreground">{labelTail}</span>
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
      </div>
      {error ? (
        <div
          className="w-full text-[11px] text-destructive"
          data-testid="deferred-approval-chip-error"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
