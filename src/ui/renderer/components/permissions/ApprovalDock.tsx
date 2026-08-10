import { useEffect, useId, useRef } from "react";
import { canonicalStringify } from "../../../../shared/canonical-json.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import { DockedApprovalCard } from "./DockedApprovalCard.js";

export interface ApprovalDockProps {
  queue: ApprovalRequest[];
  proposedChoice?: ApprovalChoice | null;
  onDecide: (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => void | Promise<void>;
}

/**
 * Route-independent, bottom-floating foreground approval surface.
 *
 * The dock is deliberately an absolutely positioned sibling of routed content
 * inside AppShell's padded route canvas. It never changes the route's measured
 * height and it does not portal over the viewport, so the user can keep reading
 * and navigating the route that raised the request around the card. All
 * ApprovalRequest variants share this one queue head and no approval surface
 * uses role=dialog, aria-modal, a backdrop, a focus trap, or body scroll lock.
 */
export function ApprovalDock({ queue, proposedChoice = null, onDecide }: ApprovalDockProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const request = queue[0] ?? null;
  const requestId = request?.id ?? null;
  const rootRef = useRef<HTMLElement>(null);
  const previousRequestIdRef = useRef<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dockHadFocusBeforeRender =
    requestId === null && rootRef.current?.contains(document.activeElement) === true;

  useEffect(() => {
    const previousRequestId = previousRequestIdRef.current;

    if (previousRequestId === null && requestId !== null) {
      const activeElement = document.activeElement;
      returnFocusRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
    } else if (
      previousRequestId !== null &&
      requestId !== null &&
      previousRequestId !== requestId
    ) {
      // Move into the new request's actual keyboard surface, not the header.
      // That keeps the visible focus indicator and the advertised A/D/Escape
      // (plus arrow/digit scope navigation) live immediately after FIFO
      // advances.
      const frame = requestAnimationFrame(() => {
        const target = rootRef.current?.querySelector<HTMLElement>(
          request?.kind === "out-of-allowed-dir"
            ? '[data-testid="docked-approval-choice-allow-once"]'
            : '[data-testid="tool-approval-panel"]',
        );
        target?.focus();
      });
      previousRequestIdRef.current = requestId;
      return () => cancelAnimationFrame(frame);
    } else if (previousRequestId !== null && requestId === null) {
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      if (dockHadFocusBeforeRender && returnTarget?.isConnected) {
        const frame = requestAnimationFrame(() => returnTarget.focus());
        previousRequestIdRef.current = requestId;
        return () => cancelAnimationFrame(frame);
      }
    }

    previousRequestIdRef.current = requestId;
  }, [dockHadFocusBeforeRender, requestId]);

  if (!request) return null;

  const isRationale = request.kind === "rationale";
  const title = request.kind === "agent-action"
    ? t("toolApprovalDialog.agentActionTitle")
    : t("toolApprovalDialog.toolApprovalTitle");
  const liveRequestLabel = isRationale ? title : `${title}. ${request.toolName}`;
  const remaining = Math.max(0, queue.length - 1);

  const decide = (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => {
    if (extras === undefined) {
      void onDecide(choice, pattern);
    } else {
      void onDecide(choice, pattern, extras);
    }
  };

  return (
    <section
      ref={rootRef}
      className="pointer-events-auto absolute z-40 mx-auto flex min-w-0 max-w-[58rem] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-2xl"
      style={{
        left: "max(0.75rem, env(safe-area-inset-left, 0px))",
        right: "max(0.75rem, env(safe-area-inset-right, 0px))",
        width: "auto",
        bottom: "max(var(--approval-overlay-bottom, 0.75rem), env(safe-area-inset-bottom, 0px))",
        maxHeight: "min(48dvh, 28rem, max(8rem, calc(100% - max(var(--approval-overlay-bottom, 0.75rem), env(safe-area-inset-bottom, 0px)) - 0.75rem)))",
      }}
      data-testid="approval-dock"
      data-overlay-position="bottom"
      data-approval-request-id={isRationale ? undefined : request.id}
      data-approval-tool-name={isRationale ? undefined : request.toolName}
      data-approval-args={isRationale ? undefined : canonicalStringify(request.args)}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-2">
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate text-sm font-semibold"
        >
          {title}
        </h2>
        {remaining > 0 ? (
          <span
            className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
            data-testid="approval-queue-depth"
            aria-label={t("toolApprovalDialog.pendingCount", { count: remaining })}
          >
            1 / {queue.length}
          </span>
        ) : null}
      </header>
      <p id={descriptionId} className="sr-only">
        {t("toolApprovalDialog.dialogDescription")}
      </p>

      {request.kind === "out-of-allowed-dir" ? (
        <DockedApprovalCard
          request={request}
          onDecide={decide}
          proposedChoice={proposedChoice}
        />
      ) : (
        <ToolApprovalContent
          open
          request={request}
          pendingCount={queue.length}
          onDecide={decide}
        />
      )}

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={request.id}>
          {liveRequestLabel}. {remaining > 0
            ? t("toolApprovalDialog.pendingCount", { count: remaining })
            : ""}
        </span>
      </p>
    </section>
  );
}
