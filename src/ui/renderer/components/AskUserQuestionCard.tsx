/**
 * AskUserQuestionCard — inline chat-side multi-question prompt for the
 * `ask_user_question` LLM tool.
 *
 * Flow:
 *   - 1 question  → render the question form, then a single "보내기" submit.
 *   - 2–4 questions → paginate through each question with a 다음/이전 nav,
 *     then a final confirm page that lists every answer for review.
 *   - "건너뛰기" at any step dismisses the entire card; the gate sees
 *     `dismissed: true` and the LLM gets `dismissed:true` in its
 *     tool_result so it can fall back to defaults.
 *
 * Card surface (compact, in-stream):
 *   - Single-line `placeholder` Input for free-text answer (no Textarea
 *     to avoid the prior popup's vertical bloat).
 *   - Recommend / 대안 badges are rendered by the UI based on the model's
 *     `recommendedIndex` / `altIndices`. Models do NOT inline these
 *     markers in the choice label itself, which lets the 20-char anchor
 *     apply to the actual answer text.
 *   - The 20-char anchors on `choices[].label` and `placeholder` are
 *     advisory only here — the prompt enforces; the UI renders whatever
 *     the model produces and trusts upstream validation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Input } from "../../../components/ui/input.js";
import type { LvisApi } from "../types.js";

export interface AskUserQuestionItem {
  question: string;
  choices?: string[];
  /**
   * Index in `choices` of the model's top recommendation. 0 or 1 entry
   * across the array (the prompt enforces; the UI ignores anything past
   * the first true `recommend`).
   */
  recommendedIndex?: number;
  /**
   * Indices in `choices` of secondary recommendations. Disjoint with
   * `recommendedIndex` — duplicates collapse to the recommend slot.
   */
  altIndices?: number[];
  allowFreeText: boolean;
  /**
   * Single-line placeholder for the free-text input. Korean ≤ 20 chars
   * by prompt contract; the UI does not enforce.
   */
  placeholder?: string;
  /**
   * Short row label used by the confirm-step review. Korean ≤ 10 chars
   * by prompt contract. Falls back to a truncated `question` when absent.
   */
  summaryHint?: string;
  /**
   * @deprecated Pre-recommend/alt API. The pre-existing 3-suggestion
   * chip array. Treated as `choices` if `choices` is missing.
   */
  suggestedAnswers?: string[];
}

export interface AskUserQuestionRequest {
  id: string;
  questions: AskUserQuestionItem[];
  createdAt: number;
}

interface DraftAnswer {
  choice?: string;
  /**
   * Index in the question's `choices` array of the selected chip. Carried
   * alongside `choice` so the UI can disambiguate duplicate choice labels —
   * comparing selection by string would visually mark every same-label
   * chip as selected at once.
   */
  choiceIndex?: number;
  freeText?: string;
}

export interface AskUserQuestionCardProps {
  api: LvisApi;
  request: AskUserQuestionRequest;
  onResolved: (id: string) => void;
}

function isAnswerComplete(item: AskUserQuestionItem, draft: DraftAnswer): boolean {
  if (draft.choice && draft.choice.length > 0) return true;
  if (item.allowFreeText && draft.freeText && draft.freeText.trim().length > 0) {
    return true;
  }
  return false;
}

function describeAnswer(item: AskUserQuestionItem, draft: DraftAnswer): string {
  if (draft.choice) return draft.choice;
  if (item.allowFreeText && draft.freeText) return draft.freeText.trim();
  return "(미응답)";
}

function effectiveChoices(item: AskUserQuestionItem): string[] {
  if (item.choices && item.choices.length > 0) return item.choices;
  if (item.suggestedAnswers && item.suggestedAnswers.length > 0) return item.suggestedAnswers;
  return [];
}

function recommendIndex(item: AskUserQuestionItem): number | null {
  const list = effectiveChoices(item);
  const r = item.recommendedIndex;
  if (typeof r !== "number") return null;
  if (r < 0 || r >= list.length) return null;
  return r;
}

function altIndices(item: AskUserQuestionItem): Set<number> {
  const list = effectiveChoices(item);
  const recommend = recommendIndex(item);
  const out = new Set<number>();
  for (const i of item.altIndices ?? []) {
    if (typeof i !== "number") continue;
    if (i < 0 || i >= list.length) continue;
    if (i === recommend) continue;
    out.add(i);
  }
  return out;
}

export function AskUserQuestionCard({
  api,
  request,
  onResolved,
}: AskUserQuestionCardProps) {
  const total = request.questions.length;
  const isMulti = total > 1;
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<DraftAnswer[]>(
    () => request.questions.map(() => ({})),
  );
  const [submitting, setSubmitting] = useState(false);

  // New request → reset all internal state. The id is the discriminator
  // so re-rendering the same card with the same questions keeps state.
  useEffect(() => {
    setStep(0);
    setDrafts(request.questions.map(() => ({})));
  }, [request.id, request.questions]);

  const onConfirmStep = isMulti && step === total;
  const currentItem = onConfirmStep ? null : request.questions[step];
  const currentDraft = drafts[step];

  const allAnswered = useMemo(
    () => request.questions.every((item, i) => isAnswerComplete(item, drafts[i])),
    [request.questions, drafts],
  );

  const setAnswer = (index: number, next: DraftAnswer) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? next : d)));
  };

  const respondAndClose = async (
    body:
      | { answers: DraftAnswer[] }
      | { dismissed: true },
  ) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.respondAskUserQuestion({
        requestId: request.id,
        ...body,
      });
      onResolved(request.id);
    } finally {
      setSubmitting(false);
    }
  };

  const submitAll = () =>
    void respondAndClose({
      answers: drafts.map((d) => ({
        choice: d.choice,
        freeText: d.freeText?.trim() || undefined,
      })),
    });

  const dismiss = () => void respondAndClose({ dismissed: true });

  // Single-question path: pick a choice → submit immediately. No pagination,
  // no confirm step — same UX as the prior single-question card.
  const goNext = () => {
    if (!currentItem) return;
    if (!isMulti) {
      submitAll();
      return;
    }
    setStep((s) => Math.min(s + 1, total));
  };
  const goPrev = () => setStep((s) => Math.max(s - 1, 0));

  // Always-defined submit handler: validates against the *current* draft at
  // call time rather than at render time. This prevents the stale-closure bug
  // where onSubmit was only passed when isAnswerComplete was true at render,
  // but the keyboard handler needed it to fire after the draft was updated.
  const handleSubmit = useCallback(() => {
    if (currentItem && isAnswerComplete(currentItem, currentDraft)) {
      goNext();
    }
  }, [currentItem, currentDraft, goNext]);

  const stepLabel = onConfirmStep
    ? "검토"
    : isMulti
      ? `${step + 1} / ${total}`
      : null;

  return (
    <Card
      className="w-full max-w-none border border-l-4 border-l-message-user bg-card shadow-none"
      data-testid="ask-user-question-card"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !submitting) {
          e.preventDefault();
          dismiss();
        }
      }}
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-3 pt-3 pb-1.5 space-y-0">
        <CardTitle className="text-[12px] font-medium text-muted-foreground">
          ❓ 질문
        </CardTitle>
        {stepLabel && (
          <span className="text-[10px] text-muted-foreground/70" data-testid="ask-step-label">
            · {stepLabel}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-2 px-3 pb-3">
        {currentItem ? (
          <QuestionForm
            item={currentItem}
            draft={currentDraft}
            disabled={submitting}
            onChoose={(choice, choiceIndex) => {
              setAnswer(step, { choice, choiceIndex });
              if (!isMulti) {
                void respondAndClose({ answers: [{ choice }] });
              }
              // Return whether the new draft is complete so the keyboard
              // handler can advance synchronously without relying on the
              // stale onSubmit closure (which reflects pre-selection state).
              return isAnswerComplete(currentItem, { choice, choiceIndex });
            }}
            onFreeText={(freeText) => setAnswer(step, { freeText })}
            onSubmit={handleSubmit}
            onAdvance={goNext}
          />
        ) : (
          <ConfirmReview
            request={request}
            drafts={drafts}
            onJumpTo={(idx) => setStep(idx)}
          />
        )}
        <div className="flex items-center justify-between gap-2 border-t border-dashed pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={dismiss}
            className="h-7 px-2 text-[11px]"
          >
            건너뛰기
          </Button>
          <div className="flex items-center gap-2">
            {isMulti && step > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={goPrev}
                className="h-7 px-3 text-[11px]"
              >
                이전
              </Button>
            )}
            {isMulti && !onConfirmStep && (
              <Button
                size="sm"
                disabled={
                  submitting ||
                  !currentItem ||
                  !isAnswerComplete(currentItem, currentDraft)
                }
                onClick={goNext}
                className="h-7 px-3 text-[11px]"
              >
                {step === total - 1 ? "검토" : "다음"}
              </Button>
            )}
            {isMulti && onConfirmStep && (
              <Button
                size="sm"
                disabled={submitting || !allAnswered}
                onClick={submitAll}
                className="h-7 px-3 text-[11px]"
              >
                보내기
              </Button>
            )}
            {!isMulti && currentItem && currentItem.allowFreeText && (
              <Button
                size="sm"
                disabled={submitting || !isAnswerComplete(currentItem, currentDraft)}
                onClick={submitAll}
                className="h-7 px-3 text-[11px]"
              >
                보내기
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * ChoiceBadge — visible in ALL button states (default/outline/selected).
 *
 * When the parent Button is `variant="default"` (selected), its background
 * becomes `bg-primary` and `text-primary` / `bg-primary/15` become
 * invisible.  Using a ring-based border-only style with `currentColor`
 * fallback text ensures the badge reads correctly against both the
 * outline (unselected) and filled primary (selected) button backgrounds.
 */
function ChoiceBadge({ kind }: { kind: "recommend" | "alt" }) {
  const cls =
    kind === "recommend"
      ? "border border-current/60 text-inherit opacity-90"
      : "border border-current/40 text-inherit opacity-60";
  return (
    <span
      className={`flex-shrink-0 rounded px-1.5 py-[1px] text-[9.5px] font-semibold tracking-wider ${cls}`}
      data-testid={`ask-badge-${kind}`}
    >
      {kind === "recommend" ? "Recommend" : "대안"}
    </span>
  );
}

function QuestionForm({
  item,
  draft,
  disabled,
  onChoose,
  onFreeText,
  onSubmit,
  onAdvance,
}: {
  item: AskUserQuestionItem;
  draft: DraftAnswer;
  disabled: boolean;
  /** Returns true if the new draft is complete (used by keyboard handler to advance). */
  onChoose: (choice: string, choiceIndex: number) => boolean;
  onFreeText: (text: string) => void;
  /**
   * Called on free-text Enter: validates current draft (which IS current
   * because free-text onChange fires before onKeyDown) then advances.
   */
  onSubmit: () => void;
  /**
   * Called by the keyboard choice handler when `onChoose` returns true.
   * Advances directly (goNext) without re-checking draft — the synchronous
   * return value of onChoose is authoritative; re-reading currentDraft here
   * would be stale due to React 18 state batching.
   */
  onAdvance: () => void;
}) {
  const choices = effectiveChoices(item);
  const recommend = recommendIndex(item);
  const alts = altIndices(item);
  // Roving tabIndex: track which choice button has the "tab stop".
  const [focusedIdx, setFocusedIdx] = useState<number>(
    () => draft.choiceIndex ?? (recommendIndex(item) ?? 0),
  );
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Reset focused idx when the question item changes (step transition).
  // Prevents out-of-range focusedIdx when the new step has fewer choices,
  // which would leave all option buttons with tabIndex={-1} (keyboard nav broken).
  useEffect(() => {
    setFocusedIdx(recommendIndex(item) ?? 0);
  }, [item]);

  // Sync focused idx when the draft's selected choice changes externally.
  useEffect(() => {
    if (typeof draft.choiceIndex === "number") {
      setFocusedIdx(draft.choiceIndex);
    }
  }, [draft.choiceIndex]);

  const handleChoiceKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
      if (disabled) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        const next = (i + 1) % choices.length;
        setFocusedIdx(next);
        buttonRefs.current[next]?.focus();
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = (i - 1 + choices.length) % choices.length;
        setFocusedIdx(prev);
        buttonRefs.current[prev]?.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        // onChoose returns whether the new draft is complete — use that
        // synchronous result to advance via onAdvance (which calls goNext
        // directly) rather than onSubmit (which re-reads currentDraft and
        // would see the pre-setAnswer stale value due to React 18 batching).
        const willBeComplete = onChoose(choices[i], i);
        if (willBeComplete) onAdvance();
      }
    },
    [disabled, choices, onChoose, onAdvance],
  );

  return (
    <>
      <div
        className="whitespace-pre-wrap text-[13px]"
        data-testid="ask-question-text"
      >
        {item.question}
      </div>
      {choices.length > 0 && (
        <div
          role="listbox"
          aria-label={item.question}
          className="flex flex-col gap-1"
        >
          {choices.map((c, i) => {
            // Selection compares by index, not by label — duplicate
            // choice strings would otherwise mark every same-label chip
            // as selected at once. The index-prefixed React key below is
            // the same defense applied to reconciliation.
            const selected = draft.choiceIndex === i;
            const showRecommend = recommend === i;
            const showAlt = alts.has(i);
            // Roving tabIndex: only the focused item (or selected item when
            // none is explicitly focused) is in the tab order.
            const isTabStop = focusedIdx === i || (focusedIdx < 0 && i === 0);
            return (
              <Button
                key={`${i}:${c}`}
                ref={(el) => { buttonRefs.current[i] = el; }}
                role="option"
                aria-selected={selected}
                tabIndex={isTabStop ? 0 : -1}
                size="sm"
                variant={selected ? "default" : "outline"}
                disabled={disabled}
                onClick={() => onChoose(c, i)}
                onKeyDown={(e) => handleChoiceKeyDown(e, i)}
                onFocus={() => setFocusedIdx(i)}
                className="h-auto justify-start gap-2 px-2.5 py-1.5 text-[12px]"
              >
                {showRecommend && <ChoiceBadge kind="recommend" />}
                {showAlt && <ChoiceBadge kind="alt" />}
                <span className="flex-1 text-left whitespace-normal">{c}</span>
              </Button>
            );
          })}
        </div>
      )}
      {item.allowFreeText && (
        <Input
          value={draft.freeText ?? ""}
          onChange={(e) => onFreeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={item.placeholder ?? "직접입력하기"}
          className="h-8 text-[12px]"
          disabled={disabled}
          data-testid="ask-freetext-input"
        />
      )}
    </>
  );
}

function ConfirmReview({
  request,
  drafts,
  onJumpTo,
}: {
  request: AskUserQuestionRequest;
  drafts: DraftAnswer[];
  onJumpTo: (idx: number) => void;
}) {
  return (
    <div className="space-y-1.5" data-testid="ask-confirm-review">
      <div className="text-[10.5px] text-muted-foreground">
        모든 답변을 확인한 뒤 보내기를 누르세요. 항목을 클릭하면 해당 질문으로 돌아갑니다.
      </div>
      <ul className="space-y-1">
        {request.questions.map((item, i) => {
          const label = item.summaryHint ?? truncateForLabel(item.question);
          return (
            <li key={i}>
              <button
                type="button"
                className="w-full rounded-md border px-2.5 py-1.5 text-left hover:bg-muted/60"
                onClick={() => onJumpTo(i)}
              >
                <div className="text-[10.5px] text-muted-foreground">{label}</div>
                <div
                  className={`text-[12px] ${isAnswerComplete(item, drafts[i]) ? "" : "text-amber-600 dark:text-amber-400"}`}
                >
                  {describeAnswer(item, drafts[i])}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function truncateForLabel(question: string): string {
  // Confirm-row label fallback when the model omits `summaryHint`.
  // Kept short (≈ 14 Korean chars) so the row matches the spec target
  // of ≤ 10 chars in most cases without dropping mid-noun in pathological
  // long questions.
  const trimmed = question.trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 13)}…`;
}
