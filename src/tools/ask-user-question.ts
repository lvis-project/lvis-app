/**
 * `ask_user_question` LLM tool — invites the assistant to surface a
 * question to the user before continuing. The tool blocks until the user
 * answers (clicks a choice / submits free text) or 5 minutes elapse.
 *
 * Renderer integration: an `AskUserQuestionCard` is shown inline in the
 * chat. The tool execution `await`s a Promise that resolves via the
 * {@link AskUserQuestionGate} IPC channel.
 */
import { createDynamicTool, type Tool } from "./base.js";
import type { AskUserQuestionGate } from "../main/ask-user-question-gate.js";

export interface AskUserQuestionToolDeps {
  getGate: () => AskUserQuestionGate | undefined;
}

export function createAskUserQuestionTool(deps: AskUserQuestionToolDeps): Tool {
  return createDynamicTool({
    name: "ask_user_question",
    description:
      "사용자에게 직접 질문하고 답을 기다립니다. 작업을 진행하기 전에 분기점이 있거나 " +
      "추가 정보가 필요할 때 사용. choices 배열을 주면 multi-choice 카드, allowFreeText=true 면 " +
      "자유 텍스트 입력. 5분 안에 답이 없으면 dismissed=true 로 반환.",
    source: "builtin",
    category: "dangerous",
    jsonSchema: {
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
      const question = typeof a.question === "string" ? a.question.trim() : "";
      if (!question) {
        return {
          output: JSON.stringify({ error: "question is required" }),
          isError: true,
        };
      }
      const choices = Array.isArray(a.choices)
        ? (a.choices as unknown[]).filter(
            (c): c is string => typeof c === "string" && c.trim().length > 0,
          )
        : undefined;
      const allowFreeText =
        typeof a.allowFreeText === "boolean" ? a.allowFreeText : true;
      const urgent = a.urgent === true;
      const response = await gate.ask({
        question,
        choices,
        allowFreeText,
        urgent,
        // Honor the user's 중단 button — without this the gate sits on its
        // 5-minute timer regardless of the conversation loop's abort.
        abortSignal: ctx.abortSignal,
      });
      return {
        output: JSON.stringify({
          choice: response.choice,
          freeText: response.freeText,
          dismissed: response.dismissed === true,
        }),
        isError: false,
      };
    },
  });
}
