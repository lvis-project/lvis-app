import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Card } from "../../../../components/ui/card.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";
import { buildApprovalScopeOptions } from "../../../../permissions/approval-scope-options.js";
import { useTranslation } from "../../../../i18n/react.js";
import { ChevronDown } from "lucide-react";
import {
  resolveUserApprovalVerdict,
  type UserApprovalVerdict,
} from "../../../../shared/permissions-events.js";

export interface DockedApprovalCardProps {
  request: ApprovalRequest | null;
  onDecide: (choice: ApprovalChoice, rememberPattern?: string) => void;
  /** Optional explicit focus return for legacy embedders. */
  onReturnFocus?: () => void;
  onOpenPermanentDeny?: (request: ApprovalRequest, verdict: UserApprovalVerdict) => void;
  interactionLocked?: boolean;
  /**
   * Scope a `/allow` sentence proposed for this request. It moves focus onto
   * that scope's button and nothing else — the button still has to be pressed.
   * See {@link ../../hooks/use-approval-sentence.js}.
   */
  proposedChoice?: ApprovalChoice | null;
}

type Scope = ReturnType<typeof buildApprovalScopeOptions>[number] & { available: boolean };

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
  onOpenPermanentDeny,
  proposedChoice = null,
  interactionLocked = false,
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

  // Render the same three decisions as every other approval card. The shared
  // authority still supplies the host-resolved candidate/parent paths; only
  // the obsolete session-wide intermediate scope is omitted.
  const scopes = useMemo<Scope[]>(() => {
    if (!request) return [];
    const available = buildApprovalScopeOptions({
      candidatePath,
      suggestedParent: suggestedParent ?? null,
      ...(request.allowedChoices ? { allowedChoices: request.allowedChoices } : {}),
    });
    const order: ApprovalChoice[] = ["deny-once", "allow-always", "allow-once"];
    return order.map((choice, index) => {
      const scope = available.find((candidate) => candidate.choice === choice);
      if (scope) return { ...scope, available: true };
      return {
        id: `unavailable-${index}`,
        choice,
        widens: choice === "allow-always",
        ...(choice === "allow-once" ? { path: candidatePath } : {}),
        available: false,
      } satisfies Scope;
    });
  }, [request, suggestedParent, candidatePath]);

  // A new request selects the narrowest scope without stealing focus from the
  // routed page. A later `/allow` proposal may move focus deliberately.
  useEffect(() => {
    if (!request) return;
    const onceIndex = scopes.findIndex((scope) => scope.choice === "allow-once");
    const nextIndex = onceIndex >= 0 ? onceIndex : 0;
    setActive(nextIndex);
    activeRef.current = nextIndex;
  }, [request?.id, scopes]);

  // A `/allow` sentence FILLS THE FORM: it moves focus onto the scope it
  // named, and the target line above the buttons rewrites to that scope. It
  // does not decide — `onDecide` is reachable only from a button press, so the
  // sentence still costs the user one deliberate confirm. A proposal naming a
  // scope this card is not offering is ignored rather than approximated.
  useEffect(() => {
    if (!proposedChoice) return;
    const index = scopes.findIndex((scope) => scope.available && scope.choice === proposedChoice);
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
    let wrapped = activeRef.current;
    for (let i = 0; i < scopes.length; i += 1) {
      wrapped = (wrapped + delta + scopes.length) % scopes.length;
      if (scopes[wrapped]?.available) break;
    }
    setActiveIndex(wrapped);
    buttonRefs.current[wrapped]?.focus();
  };

  const moveTo = (index: number) => {
    setActiveIndex(index);
    buttonRefs.current[index]?.focus();
  };

  const commit = (scope: Scope) => {
    if (interactionLocked || !scope.available) return;
    onDecide(scope.choice, scope.widens ? scope.path : undefined);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (interactionLocked) {
      if (
        e.key === "Escape" ||
        e.key.startsWith("Arrow") ||
        (Number.parseInt(e.key, 10) >= 1 && Number.parseInt(e.key, 10) <= scopes.length)
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

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
      const index = digit - 1;
      if (scopes[index]?.available) moveTo(index);
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
      : scope.choice === "allow-always"
          ? t("dockedApprovalCard.choiceAlways")
          : t("dockedApprovalCard.choiceDeny");

  // Only `allow-always` widens to the parent, and only it carries the
  // adjacency warning — the warning is about the directory being added.
  const showWarning =
    current.choice === "allow-always" && (outOfDir?.adjacencyWarnings.length ?? 0) > 0;
  const alwaysScope = scopes.find((scope) => scope.choice === "allow-always");
  const persistentUnavailableReason = alwaysScope?.available === false
    ? suggestedParent
      ? t("toolApprovalDialog.persistentUnavailableOneShot")
      : t("toolApprovalDialog.persistentUnavailableNoParent")
    : null;
  const approvalIsOneShot =
    request.allowedChoices !== undefined && !request.allowedChoices.includes("allow-always");

  return (
    <div
      className="min-w-0 px-3 py-2"
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
          </div>

          <details className="group min-w-0 overflow-hidden rounded-md border bg-muted/(--opacity-light)" data-testid="docked-review-details">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{t("toolApprovalDialog.reviewDetails")}</span>
                <span className="block text-[10px] text-muted-foreground">{t("toolApprovalDialog.reviewDetailsHint")}</span>
              </span>
              <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-1 border-t px-3 py-2 text-[11px]">
              <p className="break-all"><span className="font-semibold">{t("dockedApprovalCard.choiceOnce")}: </span><code>{candidatePath}</code></p>
              {suggestedParent ? (
                <p className="break-all"><span className="font-semibold">{t("dockedApprovalCard.choiceAlways")}: </span><code>{suggestedParent}</code></p>
              ) : null}
              {showWarning ? (
                <p className="m-0 text-warning" data-testid="docked-approval-warning">
                  {`⚠ ${outOfDir?.adjacencyWarnings.join(" · ")}`}
                </p>
              ) : null}
            </div>
          </details>

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{t("toolApprovalDialog.permanentDenyInSettings")}</span>
            <Button
              type="button"
              size="sm"
              variant="link"
              className="h-auto min-w-0 max-w-full shrink p-0 text-right text-[11px] whitespace-normal break-words"
              disabled={approvalIsOneShot || !onOpenPermanentDeny}
              title={approvalIsOneShot ? t("toolApprovalDialog.persistentUnavailableOneShot") : undefined}
              onClick={() => onOpenPermanentDeny?.(
                request,
                resolveUserApprovalVerdict(request),
              )}
              data-testid="open-permanent-deny-settings"
            >
              {t("toolApprovalDialog.openPermissionSettings")}
            </Button>
          </div>

          <div
            className="flex min-w-0 flex-wrap gap-2 [&>button]:min-w-0 [&>button]:h-auto [&>button]:flex-[1_1_10rem] [&>button]:whitespace-normal [&>button]:break-words [&>button]:py-2 [&>button]:leading-tight"
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
                disabled={!scope.available || interactionLocked}
                title={
                  !scope.available
                    ? scope.choice === "allow-always" && !suggestedParent
                      ? t("toolApprovalDialog.persistentUnavailableNoParent")
                      : t("toolApprovalDialog.persistentUnavailableOneShot")
                    : undefined
                }
                tabIndex={i === active ? 0 : -1}
                aria-describedby={
                  interactionLocked
                    ? "docked-approval-decision-locked"
                    : scope.choice === "allow-always" && persistentUnavailableReason
                      ? "docked-persistent-unavailable-reason"
                      : undefined
                }
                data-testid={`docked-approval-choice-${scope.choice}`}
                data-proposed={scope.available && scope.choice === proposedChoice ? "true" : undefined}
                onFocus={() => setActiveIndex(i)}
                onClick={() => commit(scope)}
                className={scope.choice === "deny-once" ? "border-destructive/(--opacity-half) text-destructive" : ""}
              >
                {label(scope)}
              </Button>
            ))}
          </div>
          {persistentUnavailableReason ? (
            <p
              id="docked-persistent-unavailable-reason"
              className="text-[10px] text-muted-foreground"
              data-testid="docked-persistent-unavailable-reason"
            >
              {persistentUnavailableReason}
            </p>
          ) : null}
          {interactionLocked ? (
            <p
              id="docked-approval-decision-locked"
              className="text-[10px] text-muted-foreground"
              data-testid="approval-decision-locked"
            >
              {t("toolApprovalDialog.decisionPendingInSettings")}
            </p>
          ) : null}
          <span className="text-[11px] text-muted-foreground">
            {t("dockedApprovalCard.keyHint")}
          </span>
        </Card>
      </div>
    </div>
  );
}
