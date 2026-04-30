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
 * Selecting a choice / submitting text / confirming on the last page
 * fires the renderer→main response and removes the card.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Textarea } from "../../../components/ui/textarea.js";
import type { LvisApi } from "../types.js";

export interface AskUserQuestionItem {
  question: string;
  choices?: string[];
  allowFreeText: boolean;
}

export interface AskUserQuestionRequest {
  id: string;
  questions: AskUserQuestionItem[];
  urgent: boolean;
  createdAt: number;
}

interface DraftAnswer {
  choice?: string;
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
    ? "최종 확인"
    : isMulti
      ? `${step + 1} / ${total}`
      : null;

  return (
    <Card
      className={`max-w-[85%] border ${request.urgent ? "border-amber-500/60 bg-amber-500/5" : ""}`}
      data-testid="ask-user-question-card"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">
          {request.urgent ? "🟠 긴급 질문" : "❓ 질문"}
        </CardTitle>
        {stepLabel && (
          <span className="text-[11px] text-muted-foreground" data-testid="ask-step-label">
            {stepLabel}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {currentItem ? (
          <QuestionForm
            item={currentItem}
            draft={currentDraft}
            disabled={submitting}
            onChoose={(choice) => {
              setAnswer(step, { choice });
              // For a single-question card, picking a choice IS the submit.
              if (!isMulti) {
                void respondAndClose({
                  answers: [{ choice }],
                });
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
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={dismiss}
          >
            건너뛰기
          </Button>
          <div className="flex items-center gap-2">
            {isMulti && step > 0 && (
              <Button variant="outline" size="sm" disabled={submitting} onClick={goPrev}>
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
              >
                {step === total - 1 ? "검토" : "다음"}
              </Button>
            )}
            {isMulti && onConfirmStep && (
              <Button
                size="sm"
                disabled={submitting || !allAnswered}
                onClick={submitAll}
              >
                보내기
              </Button>
            )}
            {!isMulti && currentItem && currentItem.allowFreeText && (
              <Button
                size="sm"
                disabled={submitting || !isAnswerComplete(currentItem, currentDraft)}
                onClick={submitAll}
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
  onChoose: (choice: string) => void;
  onFreeText: (text: string) => void;
}) {
  return (
    <>
      <div className="whitespace-pre-wrap text-sm">{item.question}</div>
      {item.choices && item.choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {item.choices.map((c) => (
            <Button
              key={c}
              size="sm"
              variant={draft.choice === c ? "default" : "outline"}
              disabled={disabled}
              onClick={() => onChoose(c)}
            >
              {c}
            </Button>
          ))}
        </div>
      )}
      {item.allowFreeText && (
        // US-FQP2.3: reduced min-height; CSS field-sizing:content for auto-expand;
        // max-h-[200px] prevents unbounded panel growth.
        <Textarea
          value={draft.freeText ?? ""}
          onChange={(e) => onFreeText(e.target.value)}
          placeholder="직접 입력..."
          className="min-h-[44px] max-h-[200px] resize-none overflow-y-auto text-sm [field-sizing:content]"
          disabled={disabled}
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
    <div className="space-y-2" data-testid="ask-confirm-review">
      <div className="text-xs text-muted-foreground">
        모든 답변을 확인한 뒤 보내기를 누르세요. 항목을 클릭하면 해당 질문으로 돌아갑니다.
      </div>
      <ul className="space-y-1.5">
        {request.questions.map((item, i) => (
          <li key={i}>
            <button
              type="button"
              className="w-full rounded-md border px-3 py-2 text-left hover:bg-muted/60"
              onClick={() => onJumpTo(i)}
            >
              <div className="text-[11px] text-muted-foreground">{i + 1}. {item.question}</div>
              <div className={`text-sm ${isAnswerComplete(item, drafts[i]) ? "" : "text-amber-600 dark:text-amber-400"}`}>
                {describeAnswer(item, drafts[i])}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
