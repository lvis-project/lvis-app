/**
 * Claude Provider — Anthropic Claude API
 *
 * GenericMessage → Anthropic MessageParam 변환
 * tool_use content blocks → ToolCallBlock 변환
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  GenericMessage,
  LLMProvider,
  StreamEvent,
  StreamTurnParams,
  ToolCallBlock,
  ToolSchema,
} from "./types.js";

export class ClaudeProvider implements LLMProvider {
  readonly vendor = "claude" as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const messages = toAnthropicMessages(params.messages);
    const tools = params.tools?.map(toAnthropicTool);

    try {
      const stream = this.client.messages.stream({
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        system: params.systemPrompt,
        messages,
        ...(tools && tools.length > 0 && { tools }),
      });

      // 토큰 단위 증분 스트리밍
      stream.on("text", (text) => {
        // handled via event iteration below
      });

      const toolCalls: ToolCallBlock[] = [];

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        }
      }

      // 스트리밍 완료 — 전체 응답에서 tool_use 추출
      const final = await stream.finalMessage();

      for (const block of final.content) {
        if (block.type === "tool_use") {
          const tc: ToolCallBlock = {
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
          toolCalls.push(tc);
          yield { type: "tool_call", ...tc };
        }
      }

      yield {
        type: "message_complete",
        stopReason: final.stop_reason === "tool_use" ? "tool_use" : "end_turn",
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
          cacheReadTokens: (final.usage as unknown as Record<string, number>)?.cache_read_input_tokens,
          cacheWriteTokens: (final.usage as unknown as Record<string, number>)?.cache_creation_input_tokens,
        },
      };
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Anthropic.APIError
          ? `Claude API 오류 (${err.status}): ${err.message}`
          : (err as Error).message,
      };
    }
  }
}

// ─── Format Conversion ──────────────────────────────

function toAnthropicMessages(messages: GenericMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
      }
      result.push({ role: "assistant", content });
    } else if (msg.role === "tool_result") {
      result.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.toolUseId,
          content: msg.content,
          ...(msg.isError && { is_error: true }),
        }],
      });
    }
  }

  return result;
}

function toAnthropicTool(schema: ToolSchema): Anthropic.Tool {
  return {
    name: schema.name,
    description: schema.description,
    input_schema: schema.inputSchema as Anthropic.Tool.InputSchema,
  };
}
