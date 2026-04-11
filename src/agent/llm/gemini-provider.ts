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

      const { history, lastUserContent } = toGeminiHistory(params.messages);
      const chat = model.startChat({ history });

      const result = await chat.sendMessageStream(lastUserContent);

      let hasToolCalls = false;

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          yield { type: "text_delta", text };
        }

        // functionCall 파트 감지
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

function toGeminiHistory(messages: GenericMessage[]): {
  history: Content[];
  lastUserContent: string | Part[];
} {
  const history: Content[] = [];
  let lastUserContent: string | Part[] = "";

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLast = i === messages.length - 1;

    if (msg.role === "user") {
      if (isLast) {
        lastUserContent = msg.content;
      } else {
        history.push({ role: "user", parts: [{ text: msg.content }] });
      }
    } else if (msg.role === "assistant") {
      const parts: Part[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.input } });
        }
      }
      history.push({ role: "model", parts });
    } else if (msg.role === "tool_result") {
      // Gemini: functionResponse는 user role 아래 part로
      if (isLast) {
        lastUserContent = [{ functionResponse: { name: "tool", response: { result: msg.content } } }];
      } else {
        history.push({
          role: "user",
          parts: [{ functionResponse: { name: "tool", response: { result: msg.content } } }],
        });
      }
    }
  }

  return { history, lastUserContent };
}

function toGeminiFunctionDeclaration(schema: ToolSchema): FunctionDeclaration {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.inputSchema as unknown as FunctionDeclarationSchema,
  };
}
