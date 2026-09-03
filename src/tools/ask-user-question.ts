



import { t } from "../i18n/index.js";
import { createDynamicTool, type Tool } from "./base.js";
import { MAX_PLACEHOLDER_LENGTH } from "../shared/ask-user-question-limits.js";
import {
  MAX_QUESTIONS_PER_CARD,
  type AskUserQuestionGate,
  type AskUserQuestionItem,
} from "../main/ask-user-question-gate.js";

export interface AskUserQuestionToolDeps {
  getGate: () => AskUserQuestionGate | undefined;
}

/**
 * Choice labels that name the input instead of an answer. Models reach for
 * these whenever the real answer cannot be enumerated, and the card then draws
 * a button reading "type here" that nobody can type into — the user's only way
 * out is to pick a label that means nothing. Such a label is dropped and the
 * question gets `allowFreeText` instead, which is the field it was asking for.
 *
 * The set stays this small on purpose: every entry names the act of entering
 * text, so none of them can be an answer a user meant to pick. Matched after
 * trimming and lower-casing.
 */
export const FREE_TEXT_STAND_IN_LABELS: readonly string[] = [
  "입력",
  "직접 입력",
  "직접입력",
  "기타",
  "other",
  "type…",
  "type...",
  "custom",
];

const FREE_TEXT_STAND_IN_SET = new Set(
  FREE_TEXT_STAND_IN_LABELS.map((label) => label.toLowerCase()),
);

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
              allowFreeText: {
                type: "boolean",
                description: t("be_askUserQuestion.allowFreeTextDesc"),
              },
              placeholder: {
                type: "string",
                maxLength: MAX_PLACEHOLDER_LENGTH,
                description: t("be_askUserQuestion.placeholderDesc"),
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
      // The card is routed to the conversation that asked it, so a call with no
      // executing session has no surface to render on and must not open a gate
      // only the timeout could close.
      if (typeof ctx.metadata?.sessionId !== "string" || ctx.metadata.sessionId.length === 0) {
        return {
          output: JSON.stringify({
            error: "ask_user_question requires an executing session",
          }),
          isError: true,
        };
      }
      const sessionId = ctx.metadata.sessionId;
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
        if (!Array.isArray(q.choices)) {
          return {
            output: JSON.stringify({
              error: "each question must provide a choices array",
            }),
            isError: true,
          };
        }
        if (
          q.choices.some(
            (choice) =>
              typeof choice !== "string" ||
              choice.trim().length === 0 ||
              choice.trim().length > 20,
          )
        ) {
          return {
            output: JSON.stringify({
              error: "each choice must be a non-empty string of at most 20 characters",
            }),
            isError: true,
          };
        }
        // Coerce a stand-in label into the field it was standing in for, then
        // carry the surviving choices with their original positions so the
        // recommend/alt badges still point at the chips the model meant.
        const keptChoices = (q.choices as string[])
          .map((choice, index) => ({ label: choice.trim(), index }))
          .filter((entry) => !FREE_TEXT_STAND_IN_SET.has(entry.label.toLowerCase()));
        const allowFreeText = q.allowFreeText === true || keptChoices.length !== q.choices.length;
        const filteredChoices = keptChoices.map((entry) => entry.label);
        const positionAfterCoercion = new Map(
          keptChoices.map((entry, position) => [entry.index, position]),
        );
        if (filteredChoices.length > 3) {
          return {
            output: JSON.stringify({
              error: "each question must provide at most 3 choices",
            }),
            isError: true,
          };
        }
        if (filteredChoices.length === 0 && !allowFreeText) {
          return {
            output: JSON.stringify({
              error: "each question must offer an answer — provide choices[] or set allowFreeText:true",
            }),
            isError: true,
          };
        }
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
          typeof recIdxRaw === "number" && Number.isInteger(recIdxRaw)
            ? positionAfterCoercion.get(recIdxRaw)
            : undefined;
        // altIndices: dedupe, drop the recommend slot, keep in-range only.
        const altIndices = (() => {
          if (!Array.isArray(q.altIndices)) return undefined;
          const seen = new Set<number>();
          for (const v of q.altIndices) {
            if (typeof v !== "number") continue;
            if (!Number.isInteger(v)) continue;
            const position = positionAfterCoercion.get(v);
            if (position === undefined) continue;
            if (position === recommendedIndex) continue;
            seen.add(position);
          }
          return seen.size > 0 ? [...seen] : undefined;
        })();
        const placeholderRaw = typeof q.placeholder === "string" ? q.placeholder.trim() : "";
        const placeholder =
          allowFreeText &&
          placeholderRaw.length > 0 &&
          placeholderRaw.length <= MAX_PLACEHOLDER_LENGTH
            ? placeholderRaw
            : undefined;
        const summaryHint =
          typeof q.summaryHint === "string" && q.summaryHint.trim().length > 0
            ? q.summaryHint.trim()
            : undefined;
        // Multi-select is only meaningful with at least one choice; otherwise
        // the field has no surface to apply to. Emit `true` only when on so
        // the absence is a clean undefined for downstream equality checks.
        const allowMultiple =
          q.allowMultiple === true && filteredChoices.length > 0 ? true : undefined;
        questions.push({
          question,
          choices: filteredChoices,
          recommendedIndex,
          altIndices,
          allowMultiple,
          allowFreeText: allowFreeText ? true : undefined,
          placeholder,
          summaryHint,
        });
      }
      const response = await gate.ask({
        questions,
        sessionId,
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
