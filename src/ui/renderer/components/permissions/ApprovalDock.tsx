import { useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { canonicalStringify } from "../../../../shared/canonical-json.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";
import type { UserApprovalVerdict } from "../../../../shared/permissions-events.js";
import { ToolApprovalContent } from "../ToolApprovalContent.js";

export interface ApprovalDockProps {
  /** The requests this surface draws, head first. */
  queue: readonly ApprovalRequest[];
  /** What the card calls the conversation that asked — the tile's title, not its id. */
  conversationLabel: string;
  proposedChoice?: ApprovalChoice | null;
  onDecide: (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => void | Promise<void>;
  onOpenPermanentDeny?: (request: ApprovalRequest, verdict: UserApprovalVerdict) => void;
  interactionLocked?: boolean;
}

/**
 * The surface a dock belongs to: the nearest `data-approval-scope` ancestor —
 * a tile's conversation column, a side chat's panel, or the window's route
 * canvas for requests no conversation claims. Everything the dock does to
 * its surroundings (inert the composer it covers, hand focus to a question
 * card) stays inside it, so a card raised by one tile is invisible to the
 * keyboard and the composer of every other.
 */
function approvalScopeOf(root: HTMLElement | null): HTMLElement | null {
  return root?.closest<HTMLElement>("[data-approval-scope]") ?? null;
}

/**
 * May this dock take focus? Only when nothing else has it, or when what has
 * it is inside this dock's own surface — a user typing in another tile is
 * never interrupted by a card that is not theirs.
 */
function focusIsFreeFor(root: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return true;
  return approvalScopeOf(root)?.contains(active) === true;
}

function pendingQuestionIn(scope: HTMLElement | null): HTMLElement | null {
  return scope?.querySelector<HTMLElement>('[data-testid="question-overlay"]') ?? null;
}

function focusPendingQuestion(scope: HTMLElement | null): boolean {
  const overlay = pendingQuestionIn(scope);
  if (!overlay) return false;
  const target = overlay.querySelector<HTMLElement>(
    '[role="option"][tabindex="0"]:not(:disabled), [role="option"]:not(:disabled), button:not(:disabled), [tabindex="0"]',
  );
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}

/**
 * Bottom-floating foreground approval surface, one per drawing surface.
 *
 * The dock is deliberately an absolutely positioned sibling of the content
 * of the surface that draws it — a tile's conversation column, a side chat's
 * panel, or the window's route canvas for requests no conversation claims.
 * It never changes that content's measured height and it does not portal
 * over the viewport, so the user can keep reading and navigating around the
 * card, and a card in one tile leaves every other tile untouched: no
 * backdrop, no focus steal, no inert composer outside its own scope. All
 * ApprovalRequest variants share this one queue head and no approval surface
 * uses role=dialog, aria-modal, a backdrop, a focus trap, or body scroll lock.
 */
export function ApprovalDock({
  queue,
  conversationLabel,
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
  // The scope outlives the section: once the queue empties the section is
  // gone, and the focus handoff below still has to find this surface's
  // question card. Captured at commit while the section is mounted.
  const scopeRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (rootRef.current) scopeRef.current = approvalScopeOf(rootRef.current);
  });
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
      // Take focus only from our own surface. Someone working in another tile
      // keeps their caret; the card waits for them to come over.
      if (focusIsFreeFor(rootRef.current)) {
        const activeElement = document.activeElement;
        returnFocusRef.current =
          activeElement instanceof HTMLElement && activeElement !== document.body
            ? activeElement
            : null;
        focusPreferredDecision();
      } else {
        returnFocusRef.current = null;
      }
      previousRequestIdRef.current = requestId;
    } else if (
      previousRequestId !== null &&
      requestId !== null &&
      previousRequestId !== requestId
    ) {
      // Keep keyboard interaction live on FIFO advance by focusing the next
      // request's real enabled decision, never a non-activating container —
      // under the same rule: never across surfaces.
      if (focusIsFreeFor(rootRef.current)) focusPreferredDecision();
      previousRequestIdRef.current = requestId;
    } else if (previousRequestId !== null && requestId === null) {
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      const scope = scopeRef.current;
      const hasPendingQuestion = pendingQuestionIn(scope) !== null;
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
          if (focusPendingQuestion(scope)) return;
          if (attempt < 3 && pendingQuestionIn(scope) !== null) {
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

  // The card covers the composer of ITS surface; that composer is inert while
  // the card is up. Composers of other surfaces are outside the scope and are
  // not touched — a tile waiting on approval is not a reason to stop typing
  // in the tile next to it.
  useEffect(() => {
    if (requestId === null) return;
    const canvas = approvalScopeOf(rootRef.current);
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
        conversationLabel={conversationLabel}
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
