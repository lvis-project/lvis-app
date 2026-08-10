import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Card } from "../../../../components/ui/card.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";
import { buildApprovalScopeOptions } from "../../../../permissions/approval-scope-options.js";
import { useTranslation } from "../../../../i18n/react.js";

export interface DockedApprovalCardProps {
  request: ApprovalRequest | null;
  onDecide: (choice: ApprovalChoice, rememberPattern?: string) => void;
  /** Optional explicit focus return for legacy embedders. */
  onReturnFocus?: () => void;
  /**
   * Scope a `/allow` sentence proposed for this request. It moves focus onto
   * that scope's button and nothing else — the button still has to be pressed.
   * See {@link ../../hooks/use-approval-sentence.js}.
   */
  proposedChoice?: ApprovalChoice | null;
}

type Scope = ReturnType<typeof buildApprovalScopeOptions>[number];

/**
 * Docked, non-modal approval card (issue #1940).
 *
 * This content lives inside the shared bottom-floating approval dock. It does not
 * create a backdrop or cover the routed page, and its own scroll container
 * keeps every scope reachable within the dock's bounded height.
 *
 * Content comes before the real button controls. The narrowest scope is the
 * first tab stop, arrow keys move deliberately between scopes, and Enter or
 * Space retains native button activation for assistive technology.
 */
export function DockedApprovalCard({
  request,
  onDecide,
  onReturnFocus,
  proposedChoice = null,
}: DockedApprovalCardProps) {
  const { t } = useTranslation();
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(0);
  // Mirrors `active` so repeated arrow keys within one render batch move from
  // the position they just moved to, not from a stale closure value.
  const activeRef = useRef(0);

  const outOfDir = request?.outOfAllowedDir;
  const suggestedParent = outOfDir?.suggestedParent;
  const candidatePath = outOfDir?.candidatePath ?? "";

  // Narrowest first: index 0 is also the first tab stop. The list comes
  // from the shared authority the host offers `/allow`, so a proposed scope
  // always names a button that exists here.
  const scopes = useMemo<Scope[]>(() => {
    if (!request) return [];
    return buildApprovalScopeOptions({
      candidatePath,
      suggestedParent: suggestedParent ?? null,
      ...(request.allowedChoices ? { allowedChoices: request.allowedChoices } : {}),
    });
  }, [request, suggestedParent, candidatePath]);

  // A new request selects the narrowest scope without stealing focus from the
  // routed page. A later `/allow` proposal may move focus deliberately.
  useEffect(() => {
    if (!request) return;
    setActive(0);
    activeRef.current = 0;
  }, [request?.id]);

  // A `/allow` sentence FILLS THE FORM: it moves focus onto the scope it
  // named, and the target line above the buttons rewrites to that scope. It
  // does not decide — `onDecide` is reachable only from a button press, so the
  // sentence still costs the user one deliberate confirm. A proposal naming a
  // scope this card is not offering is ignored rather than approximated.
  useEffect(() => {
    if (!proposedChoice) return;
    const index = scopes.findIndex((scope) => scope.choice === proposedChoice);
    if (index < 0) return;
    activeRef.current = index;
    setActive(index);
    const frame = requestAnimationFrame(() => buttonRefs.current[index]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [proposedChoice, scopes]);

  if (!request || scopes.length === 0) return null;

  const current = scopes[active] ?? scopes[0]!;

  const setActiveIndex = (index: number) => {
    activeRef.current = index;
    setActive(index);
  };

  const moveBy = (delta: number) => {
    const wrapped = (activeRef.current + delta + scopes.length) % scopes.length;
    setActiveIndex(wrapped);
    buttonRefs.current[wrapped]?.focus();
  };

  const moveTo = (index: number) => {
    setActiveIndex(index);
    buttonRefs.current[index]?.focus();
  };

  const commit = (scope: Scope) => {
    onDecide(scope.choice, scope.widens ? scope.path : undefined);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!request.requireExplicit) onDecide("deny-once");
      return;
    }

    // Enter and Space are NOT handled here — they activate the focused
    // button natively. Nothing on this card swallows a key.
    const digit = Number.parseInt(e.key, 10);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= scopes.length) {
      e.preventDefault();
      moveTo(digit - 1);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      moveBy(1);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      moveBy(-1);
      return;
    }
    if (e.key === "Tab" && e.shiftKey && onReturnFocus) {
      e.preventDefault();
      onReturnFocus();
    }
  };

  const label = (scope: Scope) =>
    scope.choice === "allow-once"
      ? t("dockedApprovalCard.choiceOnce")
      : scope.choice === "allow-session"
        ? t("dockedApprovalCard.choiceSession")
        : scope.choice === "allow-always"
          ? t("dockedApprovalCard.choiceAlways")
          : t("dockedApprovalCard.choiceDeny");

  // Only `allow-always` widens to the parent, and only it carries the
  // adjacency warning — the warning is about the directory being added.
  const showWarning =
    current.choice === "allow-always" && (outOfDir?.adjacencyWarnings.length ?? 0) > 0;

  return (
    <div
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-2 [scrollbar-gutter:stable]"
      data-testid="docked-approval-panel"
      onKeyDown={onKeyDown}
    >
      <div className="w-full min-w-0 max-w-full">
        <Card className="flex flex-col gap-2 p-2.5">
          <div className="flex flex-col gap-0.5">
            <p className="m-0 break-all text-xs">
              {t("dockedApprovalCard.headline", { toolName: request.toolName })}
            </p>
            <p
              className="m-0 break-all font-mono text-xs"
              data-testid="docked-approval-target"
            >
              {current.choice === "deny-once"
                ? t("dockedApprovalCard.denySummary")
                : current.choice === "allow-always"
                  ? t("dockedApprovalCard.targetParent", { path: current.path ?? "" })
                  : current.path}
            </p>
            {showWarning ? (
              <p className="m-0 text-xs text-warning" data-testid="docked-approval-warning">
                {`⚠ ${outOfDir?.adjacencyWarnings.join(" · ")}`}
              </p>
            ) : null}
          </div>

          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label={t("dockedApprovalCard.groupAriaLabel")}
          >
            {scopes.map((scope, i) => (
              <Button
                key={scope.choice}
                ref={(el) => {
                  buttonRefs.current[i] = el;
                }}
                type="button"
                size="sm"
                variant="outline"
                tabIndex={i === active ? 0 : -1}
                data-testid={`docked-approval-choice-${scope.choice}`}
                data-proposed={scope.choice === proposedChoice ? "true" : undefined}
                onFocus={() => setActiveIndex(i)}
                onClick={() => commit(scope)}
                className={
                  scope.choice === "deny-once"
                    ? "border-destructive/(--opacity-half) text-destructive"
                    : undefined
                }
              >
                {label(scope)}
              </Button>
            ))}
            <span className="ml-auto text-[11px] text-muted-foreground">
              {t("dockedApprovalCard.keyHint")}
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}
