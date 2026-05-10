/**
 * `ask_user_question` LLM tool — invites the assistant to surface 1–4
 * inline questions to the user before continuing. Renderer shows a single
 * AskUserQuestionCard that pages through every question, ends on a
 * confirmation step where the user can review answers, and returns all
 * responses at once. Blocks until the user confirms / dismisses or 5
 * minutes elapse.
 *
 * The conversation loop's per-turn AbortController flows in via
 * `ToolExecutionContext.abortSignal` so the user's 중단 button unblocks
 * the wait without sitting on the gate's timeout.
 */
import { createDynamicTool, type Tool } from "./base.js";
import {
  MAX_QUESTIONS_PER_CARD,
  type AskUserQuestionGate,
  type AskUserQuestionItem,
} from "../main/ask-user-question-gate.js";

export interface AskUserQuestionToolDeps {
  getGate: () => AskUserQuestionGate | undefined;
}

export function createAskUserQuestionTool(deps: AskUserQuestionToolDeps): Tool {
  return createDynamicTool({
    name: "ask_user_question",
    description:
      "사용자에게 1~4개의 관련 질문을 한 카드로 묶어서 묻고 답을 기다립니다. " +
      "사용자가 모든 질문에 답한 뒤 최종 확인 페이지에서 컨펌하면 응답이 한꺼번에 반환됩니다. " +
      "각 질문은 객관식(choices, 최대 3개, 항목당 한국어 ≤ 20자) + 자유 입력(allowFreeText, single-line) 조합. " +
      "컨텍스트로 명확히 한 답에 weight 가 있을 때만 그 인덱스를 recommendedIndex 로 표기 (전체 0 또는 1개). 그 외에 추가로 권장하고 싶은 답은 altIndices 에 0~N 개 — UI 가 칩 앞쪽에 'Recommend' / '대안' 배지를 자동 부착합니다. " +
      "사용자의 사적/외부 사실(거주지·취향 등)이 답이라면 recommendedIndex 와 altIndices 모두 비워두세요. " +
      "placeholder 는 자유입력 단서(한국어 ≤ 20자), summaryHint 는 confirm 단계 표 row label (≤ 10자). " +
      "5분 안에 확인이 없으면 dismissed=true 로 반환.",
    source: "builtin",
    category: "meta",
    decisionOverride: "always-allow-with-audit",
    jsonSchema: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_QUESTIONS_PER_CARD,
          description:
            `한 카드 안에서 사용자에게 묶어 물을 질문 1~${MAX_QUESTIONS_PER_CARD}개. ` +
            `사용자는 페이지네이션으로 차례로 답하고 마지막 컨펌 페이지에서 한꺼번에 제출.`,
          items: {
            type: "object",
            required: ["question"],
            properties: {
              question: {
                type: "string",
                description: "사용자에게 보여줄 질문 본문 (한 줄 또는 두 줄).",
              },
              choices: {
                type: "array",
                items: { type: "string" },
                maxItems: 3,
                description:
                  "버튼으로 보여줄 선택지. 최대 3개, 항목당 한국어 ≤ 20자. " +
                  "그 외 답은 자유 입력으로 사용자가 보완하므로 4개 이상 후보가 있어도 가장 가능성 높은 3개만 두세요. " +
                  "비어 있거나 생략 시 자유 입력만 표시.",
              },
              recommendedIndex: {
                type: "integer",
                minimum: 0,
                maximum: 2,
                description:
                  "choices 중 모델이 가장 권장하는 항목의 인덱스 (0~2, choices 가 최대 3개이므로). " +
                  "컨텍스트로 명확히 한 답에 weight 가 있을 때만 0개 또는 1개 항목에 부여. " +
                  "사용자의 사적/외부 사실(거주지·취향 등)이 답이면 비워두세요. " +
                  "choices 길이를 벗어난 값은 런타임에서 무시됩니다.",
              },
              altIndices: {
                type: "array",
                maxItems: 3,
                items: { type: "integer", minimum: 0, maximum: 2 },
                description:
                  "choices 중 보조 권장 항목의 인덱스 배열 (0~N, choices 길이까지). " +
                  "UI 가 칩 앞쪽에 회색 '대안' 배지를 자동 부착합니다. " +
                  "recommendedIndex 와 중복되거나 choices 길이를 벗어난 값은 런타임에서 무시됩니다.",
              },
              allowFreeText: {
                type: "boolean",
                description: "자유 텍스트 입력 허용 여부. 기본 true (single-line input).",
              },
              placeholder: {
                type: "string",
                description:
                  "자유입력 input 의 placeholder 단서 (한국어 ≤ 20자). " +
                  "예: '다른 방향을 한 줄로'. 'Recommend'/'(대안)' 같은 메타 표기는 UI 가 부착하므로 텍스트에 직접 박지 마세요.",
              },
              summaryHint: {
                type: "string",
                description:
                  "다중 질문 카드의 confirm 단계에서 답변 옆에 보일 row label (한국어 ≤ 10자). " +
                  "예: '수정 방향', '대상 자료'. 생략 시 question 자체를 짧게 잘라 사용.",
              },
              suggestedAnswers: {
                type: "array",
                items: { type: "string" },
                description:
                  "[deprecated — choices + recommendedIndex/altIndices 를 사용하세요] " +
                  "구버전 호환을 위해 받지만, choices 가 있으면 무시됩니다. " +
                  "신규 호출에서는 사용하지 마세요.",
              },
            },
          },
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const gate = deps.getGate();
      if (!gate) {
        return {
          output: JSON.stringify({
            error: "ask_user_question gate not configured (no active window)",
          }),
          isError: true,
        };
      }
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const rawQuestions = Array.isArray(a.questions) ? a.questions : null;
      if (!rawQuestions || rawQuestions.length === 0) {
        return {
          output: JSON.stringify({
            error: "questions[] is required and must contain at least one item",
          }),
          isError: true,
        };
      }
      if (rawQuestions.length > MAX_QUESTIONS_PER_CARD) {
        return {
          output: JSON.stringify({
            error: `questions[] capped at ${MAX_QUESTIONS_PER_CARD} per card`,
          }),
          isError: true,
        };
      }
      const questions: AskUserQuestionItem[] = [];
      for (const raw of rawQuestions) {
        const q = (raw ?? {}) as Record<string, unknown>;
        const question = typeof q.question === "string" ? q.question.trim() : "";
        if (!question) {
          return {
            output: JSON.stringify({
              error: "every questions[].question must be a non-empty string",
            }),
            isError: true,
          };
        }
        // Cap choices at 3 per spec; the rest is covered by free-text.
        const filteredChoices = Array.isArray(q.choices)
          ? (q.choices as unknown[]).filter(
              (c): c is string => typeof c === "string" && c.trim().length > 0,
            ).slice(0, 3)
          : undefined;
        const allowFreeText = q.allowFreeText !== false;
        // Refuse an unanswerable shape: no choices AND no free-text
        // input would render a question with no inputs at all and the
        // user would only be able to dismiss the card.
        if ((!filteredChoices || filteredChoices.length === 0) && !allowFreeText) {
          return {
            output: JSON.stringify({
              error:
                "each question must allow at least one input — provide choices[] or set allowFreeText:true (default)",
            }),
            isError: true,
          };
        }
        // recommendedIndex: keep only when it points inside `filteredChoices`.
        // 2개 이상 true 가 되어버리는 케이스는 schema 가 integer 하나만 받게 강제하므로
        // 추가 dedup 불필요.
        const recIdxRaw = q.recommendedIndex;
        const recommendedIndex =
          typeof recIdxRaw === "number" &&
          Number.isInteger(recIdxRaw) &&
          recIdxRaw >= 0 &&
          filteredChoices &&
          recIdxRaw < filteredChoices.length
            ? recIdxRaw
            : undefined;
        // altIndices: dedupe, drop the recommend slot, keep in-range only.
        const altIndices = (() => {
          if (!Array.isArray(q.altIndices) || !filteredChoices) return undefined;
          const seen = new Set<number>();
          for (const v of q.altIndices) {
            if (typeof v !== "number") continue;
            if (!Number.isInteger(v)) continue;
            if (v < 0 || v >= filteredChoices.length) continue;
            if (v === recommendedIndex) continue;
            seen.add(v);
          }
          return seen.size > 0 ? [...seen] : undefined;
        })();
        const placeholder =
          typeof q.placeholder === "string" && q.placeholder.trim().length > 0
            ? q.placeholder.trim()
            : undefined;
        const summaryHint =
          typeof q.summaryHint === "string" && q.summaryHint.trim().length > 0
            ? q.summaryHint.trim()
            : undefined;
        // Legacy `suggestedAnswers` kept for backward compat — only honored
        // when `choices` is absent so new callers don't accidentally double-list.
        const filteredSuggestedAnswers = Array.isArray(q.suggestedAnswers)
          ? (q.suggestedAnswers as unknown[]).filter(
              (s): s is string => typeof s === "string" && s.trim().length > 0,
            ).slice(0, 3)
          : undefined;
        questions.push({
          question,
          choices: filteredChoices && filteredChoices.length > 0 ? filteredChoices : undefined,
          recommendedIndex,
          altIndices,
          allowFreeText,
          placeholder,
          summaryHint,
          suggestedAnswers:
            (!filteredChoices || filteredChoices.length === 0) &&
            filteredSuggestedAnswers &&
            filteredSuggestedAnswers.length > 0
              ? filteredSuggestedAnswers
              : undefined,
        });
      }
      const response = await gate.ask({
        questions,
        // Honor the user's 중단 button — without this the gate sits on its
        // 5-minute timer regardless of the conversation loop's abort.
        abortSignal: ctx.abortSignal,
      });
      return {
        output: JSON.stringify({
          answers: response.answers ?? [],
          dismissed: response.dismissed === true,
        }),
        isError: false,
      };
    },
  });
}
