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
    const originalToolNames = params.tools?.map((t) => t.name) ?? [];
    const messages = toOpenAIMessages(params.systemPrompt, params.messages, originalToolNames);
    const tools = params.tools?.map(toOpenAITool);

    try {
      const stream = await this.client.chat.completions.create({
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        messages,
        ...(tools && tools.length > 0 && { tools }),
        stream: true,
      });

      // 스트리밍 파싱: text delta + tool_call 수집
      const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        finishReason = chunk.choices[0]?.finish_reason ?? finishReason;

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

      // tool_call 이벤트 발행 (이름 역변환: underscore → dot)
      for (const [, tc] of pendingToolCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.args); } catch { /* 파싱 실패 시 빈 객체 */ }
        yield { type: "tool_call", id: tc.id, name: restoreToolName(tc.name, originalToolNames), input };
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

// ─── Tool Name Sanitization (OpenAI: ^[a-zA-Z0-9_-]+$) ─

/** dot → underscore (memory.save → memory_save) */
function sanitizeToolName(name: string): string {
  return name.replace(/\./g, "_");
}

/** underscore → dot 역변환 (memory_save → memory.save) */
function restoreToolName(sanitized: string, originals: string[]): string {
  // 원본 이름 목록에서 매칭 시도
  for (const orig of originals) {
    if (sanitizeToolName(orig) === sanitized) return orig;
  }
  return sanitized;
}

// ─── Format Conversion ──────────────────────────────

function toOpenAIMessages(
  systemPrompt: string,
  messages: GenericMessage[],
  _originalToolNames: string[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content: msg.content || null,
        ...(msg.toolCalls && {
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: sanitizeToolName(tc.name), arguments: JSON.stringify(tc.input) },
          })),
        }),
      });
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
      name: sanitizeToolName(schema.name),
      description: schema.description,
      parameters: schema.inputSchema,
    },
  };
}
