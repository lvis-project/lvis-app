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

interface ChoiceRow {
  choice: ApprovalChoice;
  /** Widening choices outlive the call being decided and need the confirm step. */
  widens: boolean;
  /** Host-resolved directory this choice would allow. Never user-supplied. */
  path?: string;
}

/**
 * Docked, non-modal approval card (issue #1940).
 *
 * Placed as a sibling of the composer, outside the transcript scroll flow, so
 * it cannot scroll out of view — the placement `QuestionOverlay` already uses.
 *
 * ## How momentum is stopped without breaking a button
 *
 * Every choice is a real `<button>`. Enter and Space are NOT intercepted on
 * them — they press the button natively, so screen readers, switch access and
 * voice control keep working (WCAG 2.1.1).
 *
 * Pressing a widening choice **opens the confirm step; it does not grant**.
 * Focus deliberately stays on that choice button, so pressing Enter again
 * merely re-opens the same confirm step. The momentum chain dies without any
 * key being swallowed. Committing is a separate act: `Ctrl+Enter`, or `Tab` to
 * the confirm button — which itself behaves natively.
 *
 * The keyboard model otherwise follows `AskUserQuestionCard`: container
 * `tabIndex={0}`, roving tabIndex so the group is one tab stop, arrows and
 * number keys to move, `stopPropagation` on the committing key so the composer
 * never sees it.
 */
export function DockedApprovalCard({
  request,
  onDecide,
  onReturnFocus,
}: DockedApprovalCardProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [confirming, setConfirming] = useState<ChoiceRow | null>(null);

  const outOfDir = request?.outOfAllowedDir;
  const suggestedParent = outOfDir?.suggestedParent;

  const choices = useMemo<ChoiceRow[]>(() => {
    if (!request) return [];
    const allowed = request.allowedChoices;
    const permitted = (c: ApprovalChoice) => !allowed || allowed.includes(c);
    const out: ChoiceRow[] = [];
    if (permitted("allow-once")) out.push({ choice: "allow-once", widens: false });
    // Widening choices exist only when the host resolved a directory to widen
    // to. The path is always the host's, never anything the user supplied.
    if (suggestedParent && permitted("allow-session")) {
      out.push({ choice: "allow-session", widens: true, path: suggestedParent });
    }
    if (suggestedParent && permitted("allow-always")) {
      out.push({ choice: "allow-always", widens: true, path: suggestedParent });
    }
    // Deny is a peer button in the same group, not a corner action, so
    // refusing costs exactly as many keystrokes as allowing.
    if (permitted("deny-once")) out.push({ choice: "deny-once", widens: false });
    return out;
  }, [request, suggestedParent]);

  // New request → reset. Focus the card only when focus is not already inside
  // it, so a re-render never yanks the caret out of the composer mid-typing.
  useEffect(() => {
    if (!request) return;
    setActive(0);
    setConfirming(null);
    const frame = requestAnimationFrame(() => {
      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLElement &&
        cardRef.current?.contains(activeEl) &&
        activeEl !== cardRef.current
      ) {
        return;
      }
      (buttonRefs.current[0] ?? cardRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [request?.id]);

  // DELIBERATELY ABSENT: opening the confirm step does not move focus to the
  // confirm button.
  //
  // `AskUserQuestionCard` focuses its submit control on the confirm step, and
  // that one line is the entire momentum chain — it puts a live target under
  // the next Enter. Here the choices that reach this step grant standing
  // filesystem permission, so focus stays on the choice button and a repeated
  // Enter just re-opens the same step. Do not "fix" this by adding a focus()
  // call; the confirm button is still Tab-reachable and still activates
  // natively once focused.

  if (!request || choices.length === 0) return null;

  const press = (row: ChoiceRow) => {
    if (row.widens) setConfirming(row);
    else onDecide(row.choice);
  };

  const moveTo = (next: number) => {
    const wrapped = (next + choices.length) % choices.length;
    setActive(wrapped);
    buttonRefs.current[wrapped]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;

    if (e.key === "Escape") {
      if (confirming) {
        e.preventDefault();
        setConfirming(null);
        buttonRefs.current[active]?.focus();
        return;
      }
      // Deliberately NOT `AskUserQuestionCard`'s dismiss. On the choice group,
      // Escape keeps the fail-closed `deny-once` the modal already had —
      // redefining a shipped safety gesture is worse than the inconvenience.
      if (request.requireExplicit) return;
      e.preventDefault();
      onDecide("deny-once");
      return;
    }

    if (confirming) {
      // Needs a modifier, so no amount of Enter-momentum reaches it.
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        onDecide(confirming.choice, confirming.path);
      }
      return;
    }

    // NOTE: Enter and Space are deliberately not handled here. They press the
    // focused choice button natively.
    const digit = Number.parseInt(e.key, 10);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= choices.length) {
      e.preventDefault();
      moveTo(digit - 1);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      moveTo(active + 1);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      moveTo(active - 1);
      return;
    }
    if (e.key === "Tab" && e.shiftKey) onReturnFocus?.();
  };

  const label = (row: ChoiceRow) =>
    row.choice === "allow-once"
      ? t("dockedApprovalCard.choiceOnce")
      : row.choice === "allow-session"
        ? t("dockedApprovalCard.choiceSession")
        : row.choice === "allow-always"
          ? t("dockedApprovalCard.choiceAlways")
          : t("dockedApprovalCard.choiceDeny");

  const requestLine = `${request.toolName} · ${outOfDir?.candidatePath ?? ""}`;

  return (
    <Card
      ref={cardRef}
      tabIndex={-1}
      aria-label={t("dockedApprovalCard.cardAriaLabel")}
      data-testid="docked-approval-card"
      className="mx-3 mb-2 outline-none"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-baseline justify-between gap-3 border-b px-3 py-1.5">
        <strong className="shrink-0 text-xs font-semibold">
          {t("dockedApprovalCard.title")}
        </strong>
        <span
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={requestLine}
          data-testid="docked-approval-request"
        >
          {requestLine}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 p-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("dockedApprovalCard.groupAriaLabel")}>
          {choices.map((row, i) => (
            <Button
              key={row.choice}
              ref={(el) => {
                buttonRefs.current[i] = el;
              }}
              type="button"
              size="sm"
              variant="outline"
              tabIndex={i === active ? 0 : -1}
              aria-expanded={row.widens ? confirming?.choice === row.choice : undefined}
              data-testid={`docked-approval-choice-${row.choice}`}
              onFocus={() => setActive(i)}
              onClick={() => press(row)}
              className={
                row.choice === "deny-once"
                  ? "gap-1.5 border-destructive/(--opacity-half) text-destructive"
                  : "gap-1.5"
              }
            >
              <span className="font-mono text-[11px] opacity-60">{i + 1}</span>
              {label(row)}
            </Button>
          ))}
        </div>

        {confirming ? (
          <div
            className="flex flex-col gap-1.5 rounded-md border border-warning bg-warning/(--opacity-subtle) px-2.5 py-2"
            data-testid="docked-approval-confirm"
          >
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <dt className="opacity-75">{t("dockedApprovalCard.fieldTarget")}</dt>
              <dd className="m-0 break-all font-mono text-foreground">{confirming.path}</dd>
              <dt className="opacity-75">{t("dockedApprovalCard.fieldDuration")}</dt>
              <dd className="m-0 font-mono text-foreground">
                {confirming.choice === "allow-always"
                  ? t("dockedApprovalCard.durationAlways")
                  : t("dockedApprovalCard.durationSession")}
              </dd>
              {outOfDir && outOfDir.adjacencyWarnings.length > 0 ? (
                <>
                  <dt className="opacity-75">{t("dockedApprovalCard.fieldWarning")}</dt>
                  <dd
                    className="m-0 font-mono text-foreground"
                    data-testid="docked-approval-warning"
                  >
                    {outOfDir.adjacencyWarnings.join(" · ")}
                  </dd>
                </>
              ) : null}
            </dl>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {t("dockedApprovalCard.commitHint")}
              </span>
              <Button
                size="sm"
                data-testid="docked-approval-commit"
                onClick={() => onDecide(confirming.choice, confirming.path)}
              >
                {t("dockedApprovalCard.commitButton")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
