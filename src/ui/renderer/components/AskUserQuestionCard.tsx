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
import { useEffect, useMemo, useState } from "react";
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
  urgent: boolean;
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

  const stepLabel = onConfirmStep
    ? "검토"
    : isMulti
      ? `${step + 1} / ${total}`
      : null;

  return (
    <Card
      className={`w-full max-w-[560px] border border-l-4 border-l-message-user shadow-none ${request.urgent ? "border-amber-500/60 bg-amber-500/5" : ""}`}
      data-testid="ask-user-question-card"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-3 pt-3 pb-1.5 space-y-0">
        <CardTitle className="text-[12px] font-medium text-muted-foreground">
          {request.urgent ? "🟠 긴급 질문" : "❓ 질문"}
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
            }}
            onFreeText={(freeText) => setAnswer(step, { freeText })}
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

function ChoiceBadge({ kind }: { kind: "recommend" | "alt" }) {
  // Both badges sit at the start of the chip so the 20-char answer text
  // owns the rest of the row. Color-only difference (recommend = primary
  // blue tint, alt = neutral muted) keeps the pattern compact.
  const cls =
    kind === "recommend"
      ? "bg-primary/15 text-primary"
      : "bg-muted text-muted-foreground";
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
}: {
  item: AskUserQuestionItem;
  draft: DraftAnswer;
  disabled: boolean;
  onChoose: (choice: string, choiceIndex: number) => void;
  onFreeText: (text: string) => void;
}) {
  const choices = effectiveChoices(item);
  const recommend = recommendIndex(item);
  const alts = altIndices(item);
  return (
    <>
      <div
        className="whitespace-pre-wrap text-[13px]"
        data-testid="ask-question-text"
      >
        {item.question}
      </div>
      {choices.length > 0 && (
        <div className="flex flex-col gap-1">
          {choices.map((c, i) => {
            // Selection compares by index, not by label — duplicate
            // choice strings would otherwise mark every same-label chip
            // as selected at once. The index-prefixed React key below is
            // the same defense applied to reconciliation.
            const selected = draft.choiceIndex === i;
            const showRecommend = recommend === i;
            const showAlt = alts.has(i);
            return (
              <Button
                key={`${i}:${c}`}
                size="sm"
                variant={selected ? "default" : "outline"}
                disabled={disabled}
                onClick={() => onChoose(c, i)}
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
