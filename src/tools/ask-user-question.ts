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
      "각 질문은 객관식(choices) 또는 자유 입력(allowFreeText) 또는 둘 다 허용 가능. " +
      "allowFreeText=true 이고 choices 가 비어 있으면 반드시 그 turn 컨텍스트에서 도출한 3개의 suggestedAnswers 를 제공해야 합니다 — 정적 폴백(\"네\"/\"아니오\") 절대 사용 금지. " +
      "5분 안에 확인이 없으면 dismissed=true 로 반환.",
    source: "builtin",
    category: "dangerous",
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
                description: "버튼으로 보여줄 선택지. 빈 배열 또는 생략 시 자유 입력만.",
              },
              allowFreeText: {
                type: "boolean",
                description: "자유 텍스트 입력 허용 여부. 기본 true.",
              },
              suggestedAnswers: {
                type: "array",
                items: { type: "string" },
                minItems: 3,
                maxItems: 3,
                description:
                  "[allowFreeText=true 이고 choices 가 비어 있을 때 필수] " +
                  "이 turn 의 컨텍스트에서 모델이 생성한 3개의 contextual 후보 답변. " +
                  "UI 는 이를 quick-chip 으로 노출해 사용자가 빠르게 선택하거나 직접 입력할 수 있게 한다. " +
                  "정적 폴백(\"네\"/\"아니오\"/\"잘 모르겠어요\") 절대 사용 금지.",
              },
            },
          },
        },
        urgent: {
          type: "boolean",
          description: "긴급 표시 (UI 상단 강조). 기본 false.",
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
        const filteredChoices = Array.isArray(q.choices)
          ? (q.choices as unknown[]).filter(
              (c): c is string => typeof c === "string" && c.trim().length > 0,
            )
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
        const filteredSuggestedAnswers = Array.isArray(q.suggestedAnswers)
          ? (q.suggestedAnswers as unknown[]).filter(
              (s): s is string => typeof s === "string" && s.trim().length > 0,
            ).slice(0, 3)
          : undefined;
        questions.push({
          question,
          choices: filteredChoices && filteredChoices.length > 0 ? filteredChoices : undefined,
          allowFreeText,
          suggestedAnswers:
            filteredSuggestedAnswers && filteredSuggestedAnswers.length > 0
              ? filteredSuggestedAnswers
              : undefined,
        });
      }
      const urgent = a.urgent === true;
      const response = await gate.ask({
        questions,
        urgent,
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
