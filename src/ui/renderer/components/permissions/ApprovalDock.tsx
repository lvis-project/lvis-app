import { useCallback, useEffect, useId, useRef } from "react";
import { canonicalStringify } from "../../../../shared/canonical-json.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";
import type { UserApprovalVerdict } from "../../../../shared/permissions-events.js";
import { ToolApprovalContent } from "../ToolApprovalContent.js";

export interface ApprovalDockProps {
  queue: ApprovalRequest[];
  proposedChoice?: ApprovalChoice | null;
  onDecide: (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => void | Promise<void>;
  onOpenPermanentDeny?: (request: ApprovalRequest, verdict: UserApprovalVerdict) => void;
  interactionLocked?: boolean;
}

function focusPendingQuestion(): boolean {
  const overlay = document.querySelector<HTMLElement>('[data-testid="question-overlay"]');
  if (!overlay) return false;
  const target = overlay.querySelector<HTMLElement>(
    '[role="option"][tabindex="0"]:not(:disabled), [role="option"]:not(:disabled), button:not(:disabled), [tabindex="0"]',
  );
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}

/**
 * Route-independent, bottom-floating foreground approval surface.
 *
 * The dock is deliberately an absolutely positioned sibling of routed content
 * inside App's padded route canvas. It never changes the route's measured
 * height and it does not portal over the viewport, so the user can keep reading
 * and navigating the route that raised the request around the card. All
 * ApprovalRequest variants share this one queue head and no approval surface
 * uses role=dialog, aria-modal, a backdrop, a focus trap, or body scroll lock.
 */
export function ApprovalDock({
  queue,
  proposedChoice = null,
  onDecide,
  onOpenPermanentDeny,
  interactionLocked = false,
}: ApprovalDockProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const request = queue[0] ?? null;
  const requestId = request?.id ?? null;
  const activeRequestIdRef = useRef<string | null>(requestId);
  activeRequestIdRef.current = requestId;
  const rootRef = useRef<HTMLElement>(null);
  const previousRequestIdRef = useRef<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnFocusFrameRef = useRef<number | null>(null);
  const dockHadFocusBeforeRender =
    requestId === null && rootRef.current?.contains(document.activeElement) === true;

  const focusPreferredDecision = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    // One decision row for every request kind — fail-closed Reject first.
    const selectors = [
      '[data-testid="deny-button"]:not(:disabled)',
      '[data-testid="approve-button"]:not(:disabled)',
      '[data-testid="allow-always-button"]:not(:disabled)',
    ];
    for (const selector of selectors) {
      const target = root.querySelector<HTMLElement>(selector);
      if (target) {
        target.focus();
        return;
      }
    }
  }, []);

  useEffect(() => () => {
    if (returnFocusFrameRef.current !== null) {
      cancelAnimationFrame(returnFocusFrameRef.current);
    }
  }, []);

  useEffect(() => {
    const previousRequestId = previousRequestIdRef.current;

    if (previousRequestId === null && requestId !== null) {
      const activeElement = document.activeElement;
      returnFocusRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
      focusPreferredDecision();
      previousRequestIdRef.current = requestId;
    } else if (
      previousRequestId !== null &&
      requestId !== null &&
      previousRequestId !== requestId
    ) {
      // Keep keyboard interaction live on FIFO advance by focusing the next
      // request's real enabled decision, never a non-activating container.
      focusPreferredDecision();
      previousRequestIdRef.current = requestId;
    } else if (previousRequestId !== null && requestId === null) {
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      const hasPendingQuestion = document.querySelector('[data-testid="question-overlay"]') !== null;
      if (hasPendingQuestion || dockHadFocusBeforeRender) {
        if (returnFocusFrameRef.current !== null) {
          cancelAnimationFrame(returnFocusFrameRef.current);
        }
        const completeFocusHandoff = (attempt: number) => {
          returnFocusFrameRef.current = null;
          if (activeRequestIdRef.current !== null) return;
          // A question can arrive while its composer subtree is inert beneath
          // the approval overlay. Its one-shot mount focus cannot run again, so
          // hand focus to the now-visible question before restoring the older
          // composer/route target.
          if (focusPendingQuestion()) return;
          if (
            attempt < 3 &&
            document.querySelector('[data-testid="question-overlay"]') !== null
          ) {
            returnFocusFrameRef.current = requestAnimationFrame(
              () => completeFocusHandoff(attempt + 1),
            );
            return;
          }
          if (returnTarget?.isConnected) returnTarget.focus();
        };
        returnFocusFrameRef.current = requestAnimationFrame(() => completeFocusHandoff(0));
        previousRequestIdRef.current = requestId;
      }
    }

    previousRequestIdRef.current = requestId;
  }, [dockHadFocusBeforeRender, focusPreferredDecision, requestId]);

  useEffect(() => {
    if (requestId === null) return;
    const canvas = rootRef.current?.closest<HTMLElement>('[data-testid="route-canvas"]');
    if (!canvas) return;

    const snapshots = new Map<HTMLElement, {
      ariaHidden: string | null;
      hadInertAttribute: boolean;
      inert: boolean;
    }>();
    const obscureCoveredComposer = () => {
      for (const composer of canvas.querySelectorAll<HTMLElement>('[data-composer-placement]')) {
        if (!snapshots.has(composer)) {
          snapshots.set(composer, {
            ariaHidden: composer.getAttribute("aria-hidden"),
            hadInertAttribute: composer.hasAttribute("inert"),
            inert: composer.inert,
          });
        }
        if (composer.contains(document.activeElement)) focusPreferredDecision();
        composer.inert = true;
        composer.setAttribute("inert", "");
        composer.setAttribute("aria-hidden", "true");
      }
    };

    obscureCoveredComposer();
    const observer = new MutationObserver(obscureCoveredComposer);
    observer.observe(canvas, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      for (const [composer, snapshot] of snapshots) {
        composer.inert = snapshot.inert;
        if (snapshot.hadInertAttribute) composer.setAttribute("inert", "");
        else composer.removeAttribute("inert");
        if (snapshot.ariaHidden === null) composer.removeAttribute("aria-hidden");
        else composer.setAttribute("aria-hidden", snapshot.ariaHidden);
      }
    };
  }, [focusPreferredDecision, requestId]);

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
    if (interactionLocked || activeRequestIdRef.current !== request.id) return;
    if (extras === undefined) {
      void onDecide(choice, pattern);
    } else {
      void onDecide(choice, pattern, extras);
    }
  };

  return (
    <section
      ref={rootRef}
      className="pointer-events-auto absolute z-40 mx-auto flex min-w-0 max-w-(--reading-column-max) flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-2xl"
      style={{
        left: "max(0.75rem, env(safe-area-inset-left, 0px))",
        right: "max(0.75rem, env(safe-area-inset-right, 0px))",
        width: "auto",
        bottom: "max(0.75rem, env(safe-area-inset-bottom, 0px))",
        maxHeight: "min(48dvh, 28rem, max(8rem, calc(100% - max(0.75rem, env(safe-area-inset-bottom, 0px)) - 0.75rem)))",
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
      {/* One visible header for every kind — same title placement, same
          queue-depth chip, regardless of what raised the request. */}
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-2">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold">
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

      {/* One frame for every kind. Path-grant (out-of-allowed-dir) requests
          render their evidence and decisions INSIDE ToolApprovalContent —
          the dock never forks to a second component with its own visual
          language. */}
      <ToolApprovalContent
        key={request.id}
        open
        request={request}
        pendingCount={queue.length}
        onDecide={decide}
        onOpenPermanentDeny={onOpenPermanentDeny}
        proposedChoice={proposedChoice}
        interactionLocked={interactionLocked}
      />

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
