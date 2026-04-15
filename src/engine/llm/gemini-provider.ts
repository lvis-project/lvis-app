/**
 * Gemini Provider — Google Generative AI (Gemini)
 *
 * GenericMessage → Gemini Content 변환
 * functionCall → ToolCallBlock 변환
 */
import { GoogleGenerativeAI, type Content, type Part, type FunctionDeclaration, type FunctionDeclarationSchema } from "@google/generative-ai";
import type {
  GenericMessage,
  LLMProvider,
  StreamEvent,
  StreamTurnParams,
  ToolSchema,
} from "./types.js";

export class GeminiProvider implements LLMProvider {
  readonly vendor = "gemini" as const;
  private readonly genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    try {
      const tools = params.tools?.map(toGeminiFunctionDeclaration);
      const model = this.genAI.getGenerativeModel({
        model: params.model,
        systemInstruction: params.systemPrompt,
        ...(tools && tools.length > 0 && {
          tools: [{ functionDeclarations: tools }],
        }),
      });

      // 전체 히스토리를 Content 배열로 변환 (Stateless 방식)
      const contents = toGeminiContents(params.messages);
      const result = await model.generateContentStream({ contents });

      let hasToolCalls = false;

      for await (const chunk of result.stream) {
        try {
          const text = chunk.text();
          if (text) {
            yield { type: "text_delta", text };
          }
        } catch { /* text가 없는 chunk인 경우 무시 */ }

        for (const candidate of chunk.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            if (part.functionCall) {
              hasToolCalls = true;
              yield {
                type: "tool_call",
                id: `gemini-${Date.now()}-${part.functionCall.name}`,
                name: part.functionCall.name,
                input: (part.functionCall.args ?? {}) as Record<string, unknown>,
              };
            }
          }
        }
      }

      const response = await result.response;
      const usage = response.usageMetadata;

      yield {
        type: "message_complete",
        stopReason: hasToolCalls ? "tool_use" : "end_turn",
        usage: usage
          ? {
              inputTokens: usage.promptTokenCount ?? 0,
              outputTokens: usage.candidatesTokenCount ?? 0,
            }
          : undefined,
      };
    } catch (err) {
      yield { type: "error", error: (err as Error).message };
    }
  }
}

// ─── Format Conversion ──────────────────────────────

function toGeminiContents(messages: GenericMessage[]): Content[] {
  return messages.map((msg) => {
    let role: string = "user";
    let parts: Part[] = [];

    if (msg.role === "user") {
      role = "user";
      parts = [{ text: msg.content }];
    } else if (msg.role === "assistant") {
      role = "model";
      if (msg.content) parts.push({ text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.input } });
        }
      }
    } else if (msg.role === "tool_result") {
      // Gemini: functionResponse는 user role로 전달
      role = "user";
      parts = [{
        functionResponse: {
          name: msg.toolName || "tool",
          response: { result: msg.content },
        },
      }];
    }

    return { role, parts };
  });
}

function toGeminiFunctionDeclaration(schema: ToolSchema): FunctionDeclaration {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.inputSchema as unknown as FunctionDeclarationSchema,
  };
}
