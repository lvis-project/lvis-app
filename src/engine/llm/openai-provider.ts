/**
 * OpenAI Provider — OpenAI API + GitHub Copilot (OpenAI-compatible)
 *
 * GenericMessage → OpenAI ChatCompletionMessageParam 변환
 * function_call → ToolCallBlock 변환
 *
 * Copilot: baseUrl을 "https://models.github.ai/inference" 로 설정하면 동작
 */
import OpenAI from "openai";
import type {
  GenericMessage,
  LLMProvider,
  LLMVendor,
  StreamEvent,
  StreamTurnParams,
  ToolSchema,
} from "./types.js";

export class OpenAIProvider implements LLMProvider {
  readonly vendor: LLMVendor;
  private readonly client: OpenAI;

  constructor(apiKey: string, vendor: "openai" | "copilot" = "openai", baseUrl?: string) {
    this.vendor = vendor;
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl && { baseURL: baseUrl }),
    });
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const modelLower = params.model.toLowerCase();
    // Reasoning-capable families: o-series (o1/o3/o4+) and gpt-5.x.
    // Chat-completions emits reasoning_content deltas when reasoning is active
    // for these families; the call-site toggles visibility via reasoning_effort.
    const isReasoningModel =
      modelLower.includes("o1") ||
      modelLower.includes("o3") ||
      modelLower.includes("o4") ||
      modelLower.includes("gpt-5") ||
      modelLower.includes("reasoning");
    // Reasoning + gpt-4o / gpt-4.5 families require max_completion_tokens.
    const useMaxCompletionTokens =
      isReasoningModel ||
      modelLower.includes("gpt-4o") ||
      modelLower.includes("gpt-4.5");

    // Map LVIS settings onto OpenAI's reasoning_effort. Budgets above ~8k are
    // "high", below ~3k are "low"; the middle band maps to "medium". This keeps
    // our single Claude-style budget knob working for OpenAI too.
    const useThinking = params.enableThinking === true && isReasoningModel;
    const budget = params.thinkingBudgetTokens ?? 10_000;
    const reasoningEffort: "low" | "medium" | "high" = budget >= 8000
      ? "high"
      : budget <= 3000
        ? "low"
        : "medium";

    console.log(`[OpenAIProvider] model="${params.model}", isReasoning=${isReasoningModel}, useMaxCompletionTokens=${useMaxCompletionTokens}, reasoning=${useThinking ? reasoningEffort : "off"}`);

    const messages = toOpenAIMessages(params.systemPrompt, params.messages, isReasoningModel);
    const tools = params.tools?.map(toOpenAITool);

    try {
      const stream = await this.client.chat.completions.create({
        model: params.model,
        ...(useMaxCompletionTokens
          ? { max_completion_tokens: params.maxTokens ?? 4096 }
          : { max_tokens: params.maxTokens ?? 4096 }),
        messages,
        ...(tools && tools.length > 0 && { tools }),
        ...(useThinking && { reasoning_effort: reasoningEffort }),
        stream: true,
      });

      // 스트리밍 파싱: text delta + tool_call 수집
      const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        finishReason = chunk.choices[0]?.finish_reason ?? finishReason;

        const reasoningContent = (delta as { reasoning_content?: string | null } | undefined)?.reasoning_content;
        if (reasoningContent) {
          yield { type: "reasoning_delta", text: reasoningContent };
        }

        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!pendingToolCalls.has(idx)) {
              pendingToolCalls.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
            }
            const pending = pendingToolCalls.get(idx)!;
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) pending.args += tc.function.arguments;
          }
        }
      }

      // tool_call 이벤트 발행
      for (const [, tc] of pendingToolCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.args); } catch { /* 파싱 실패 시 빈 객체 */ }
        yield { type: "tool_call", id: tc.id, name: tc.name, input };
      }

      yield {
        type: "message_complete",
        stopReason: finishReason === "tool_calls" ? "tool_use" : "end_turn",
        usage: {
          inputTokens: 0, // OpenAI 스트리밍에서는 usage가 마지막 chunk에만 옴
          outputTokens: 0,
        },
      };
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof OpenAI.APIError
          ? `OpenAI API 오류 (${err.status}): ${err.message}`
          : (err as Error).message,
      };
    }
  }
}

// ─── Format Conversion ──────────────────────────────

function toOpenAIMessages(
  systemPrompt: string,
  messages: GenericMessage[],
  isReasoningModel: boolean = false,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [
    { role: isReasoningModel ? ("developer" as any) : "system", content: systemPrompt },
  ];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
        role: "assistant",
        content: msg.content || null,
        ...(msg.toolCalls && {
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        }),
      };
      if (isReasoningModel && (msg.thought !== undefined || msg.toolCalls)) {
        assistantMessage.reasoning_content = msg.thought ?? "";
      }
      result.push(assistantMessage);
    } else if (msg.role === "tool_result") {
      result.push({
        role: "tool",
        tool_call_id: msg.toolUseId,
        content: msg.content,
      });
    }
  }

  return result;
}

function toOpenAITool(schema: ToolSchema): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.inputSchema,
    },
  };
}
