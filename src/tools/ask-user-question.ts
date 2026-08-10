



import { t } from "../i18n/index.js";
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
    description: t("be_askUserQuestion.toolDescription"),
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
          description: t("be_askUserQuestion.questionsDesc", { max: MAX_QUESTIONS_PER_CARD }),
          items: {
            type: "object",
            required: ["question", "choices"],
            properties: {
              question: {
                type: "string",
                description: t("be_askUserQuestion.questionItemDesc"),
              },
              choices: {
                type: "array",
                items: { type: "string", minLength: 1, maxLength: 20 },
                minItems: 1,
                maxItems: 3,
                uniqueItems: true,
                description: t("be_askUserQuestion.choicesDesc"),
              },
              recommendedIndex: {
                type: "integer",
                minimum: 0,
                maximum: 2,
                description: t("be_askUserQuestion.recommendedIndexDesc"),
              },
              altIndices: {
                type: "array",
                maxItems: 3,
                items: { type: "integer", minimum: 0, maximum: 2 },
                description: t("be_askUserQuestion.altIndicesDesc"),
              },
              allowMultiple: {
                type: "boolean",
                description: t("be_askUserQuestion.allowMultipleDesc"),
              },
              summaryHint: {
                type: "string",
                description: t("be_askUserQuestion.summaryHintDesc"),
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
        if (!Array.isArray(q.choices) || q.choices.length === 0) {
          return {
            output: JSON.stringify({
              error: "each question must provide at least one non-empty choice",
            }),
            isError: true,
          };
        }
        if (
          q.choices.length > 3 ||
          q.choices.some(
            (choice) =>
              typeof choice !== "string" ||
              choice.trim().length === 0 ||
              choice.trim().length > 20,
          )
        ) {
          return {
            output: JSON.stringify({
              error: "each question must provide 1 to 3 non-empty choices of at most 20 characters",
            }),
            isError: true,
          };
        }
        const filteredChoices = (q.choices as string[]).map((choice) => choice.trim());
        if (new Set(filteredChoices).size !== filteredChoices.length) {
          return {
            output: JSON.stringify({
              error: "each question must provide unique choices",
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
        const summaryHint =
          typeof q.summaryHint === "string" && q.summaryHint.trim().length > 0
            ? q.summaryHint.trim()
            : undefined;
        // Multi-select is only meaningful with at least one choice; otherwise
        // the field has no surface to apply to. Emit `true` only when on so
        // the absence is a clean undefined for downstream equality checks.
        const allowMultiple =
          q.allowMultiple === true &&
          filteredChoices !== undefined &&
          filteredChoices.length > 0
            ? true
            : undefined;
        questions.push({
          question,
          choices: filteredChoices,
          recommendedIndex,
          altIndices,
          allowMultiple,
          summaryHint,
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
