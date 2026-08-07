import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Card } from "../../../../components/ui/card.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";
import { useTranslation } from "../../../../i18n/react.js";

export interface DockedApprovalCardProps {
  request: ApprovalRequest | null;
  onDecide: (choice: ApprovalChoice, rememberPattern?: string) => void;
  /** Returns focus to the composer when the user shift-tabs out of the card. */
  onReturnFocus?: () => void;
}

interface Scope {
  choice: ApprovalChoice;
  /** Widening scopes outlive the call being decided. */
  widens: boolean;
  /** Host-resolved path this scope would allow. Never user-supplied. */
  path?: string;
}

/**
 * Docked, non-modal approval card (issue #1940).
 *
 * Replaces the modal `OutOfAllowedDirCard`. Rendered as a bottom-anchored
 * overlay inside the composer dock — the placement `QuestionOverlay` uses — so
 * it grows upward over the chat surface and cannot scroll out of view.
 *
 * ## Reading order, and where safety comes from
 *
 * Content first, buttons after: what is being asked, **what this scope would
 * actually grant**, any warning — then the scopes. Moving between scopes
 * rewrites the target line, because the target is the only thing that differs
 * between them (`항상` grants the parent folder, not the file). Duration is not
 * a separate field; the button's own label is the duration.
 *
 * Three properties carry the safety, and none of them is a swallowed key:
 *
 *  1. Focus lands on the NARROWEST scope.
 *  2. What would be granted is on screen above the buttons at all times, and
 *     visibly changes as focus moves.
 *  3. Widening scopes are not reachable by repeating a key — you have to move
 *     to them first, and moving is what redraws the target.
 *
 * Every scope is a real `<button>`; nothing intercepts Enter or Space on them,
 * so screen readers, switch access and voice control keep working
 * (WCAG 2.1.1).
 */
export function DockedApprovalCard({
  request,
  onDecide,
  onReturnFocus,
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

  const scopes = useMemo<Scope[]>(() => {
    if (!request) return [];
    const allowed = request.allowedChoices;
    const permitted = (c: ApprovalChoice) => !allowed || allowed.includes(c);
    const out: Scope[] = [];
    // Narrowest first — this is also where focus lands.
    if (permitted("allow-once")) {
      out.push({ choice: "allow-once", widens: false, path: candidatePath });
    }
    if (suggestedParent && permitted("allow-session")) {
      out.push({ choice: "allow-session", widens: true, path: candidatePath });
    }
    if (suggestedParent && permitted("allow-always")) {
      out.push({ choice: "allow-always", widens: true, path: suggestedParent });
    }
    // Deny is a peer button, so refusing costs what allowing costs.
    if (permitted("deny-once")) out.push({ choice: "deny-once", widens: false });
    return out;
  }, [request, suggestedParent, candidatePath]);

  // New request → focus the narrowest scope, but never steal focus that is
  // already inside the card (a re-render must not move the user's place).
  useEffect(() => {
    if (!request) return;
    setActive(0);
    activeRef.current = 0;
    const frame = requestAnimationFrame(() => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && buttonRefs.current.includes(el as HTMLButtonElement)) {
        return;
      }
      buttonRefs.current[0]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [request?.id]);

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
      // Deliberately NOT `AskUserQuestionCard`'s dismiss: Escape keeps the
      // fail-closed `deny-once` the modal already had.
      if (request.requireExplicit) return;
      e.preventDefault();
      onDecide("deny-once");
      return;
    }

    // Widening scopes are not committed by the key that is already under the
    // user's finger. With no confirm step left, this modifier is the only
    // thing between arrow-then-Enter and a standing grant.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      commit(scopes[activeRef.current] ?? current);
      return;
    }

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
    if (e.key === "Tab" && e.shiftKey) onReturnFocus?.();
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
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex justify-center"
      data-testid="docked-approval-overlay"
      onKeyDown={onKeyDown}
    >
      <div className="w-full min-w-0 p-2">
        <Card className="flex flex-col gap-2 p-2.5">
          <div className="flex flex-col gap-0.5">
            <p className="m-0 text-xs">
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
                onFocus={() => setActiveIndex(i)}
                onClick={() => {
                  // Narrow scopes commit on native activation. Widening scopes
                  // deliberately do not: a pointer press focuses them and
                  // redraws the target, and applying is the separate
                  // Ctrl+Enter act.
                  if (!scope.widens) commit(scope);
                }}
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
