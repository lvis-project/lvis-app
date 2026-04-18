/**
 * VercelUnifiedProvider.
 *
 * Per docs/references/vercel-ai-sdk-migration.md §5.2, this is the single
 * adapter that will replace claude-provider/openai-provider/gemini-provider
 * once phases P1-P3 land.
 *
 * P1 status: Gemini path implemented. OpenAI/Claude paths still throw.
 *
 * TODO(P2): Implement OpenAI path (gpt-5.x via /v1/responses auto-routing).
 * TODO(P3): Implement Claude path (thinkingBlocks + signature + cacheControl).
 */
import { streamText, jsonSchema, tool, type ModelMessage } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type {
  LLMProvider,
  LLMVendor,
  StreamEvent,
  StreamTurnParams,
  ToolSchema,
} from "../types.js";
import { genericToModelMessages } from "./message-mapper.js";
import { fullStreamToStreamEvent } from "./stream-mapper.js";
import { mapAiSdkErrorToLvis } from "./error-mapper.js";

export class VercelUnifiedProvider implements LLMProvider {
  readonly vendor: LLMVendor;
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly customFetch?: typeof fetch;

  constructor(
    vendor: LLMVendor,
    apiKey: string,
    baseUrl?: string,
    customFetch?: typeof fetch,
  ) {
    this.vendor = vendor;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.customFetch = customFetch;
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    if (this.vendor !== "gemini") {
      throw new Error(
        `VercelUnifiedProvider: vendor "${this.vendor}" not yet implemented (P1 = gemini only). ` +
          "Set settings.llm.useVercelSdk='none' or 'gemini'.",
      );
    }

    try {
      const google = createGoogleGenerativeAI({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        ...(this.customFetch ? { fetch: this.customFetch } : {}),
      });

      const messages: ModelMessage[] = genericToModelMessages(params.messages);
      const tools = buildTools(params.tools);

      // Wrap streamText() in try/catch to also capture synchronous construction
      // errors (e.g. APICallError thrown pre-stream), not just mid-stream errors.
      let fullStream: AsyncIterable<Record<string, unknown> & { type: string }>;
      try {
        const result = streamText({
          model: google(params.model),
          system: params.systemPrompt,
          messages,
          ...(tools ? { tools } : {}),
          ...(params.maxTokens ? { maxOutputTokens: params.maxTokens } : {}),
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        });
        fullStream = result.fullStream as AsyncIterable<
          Record<string, unknown> & { type: string }
        >;
      } catch (syncErr) {
        const mapped = mapAiSdkErrorToLvis(syncErr);
        yield {
          type: "error",
          error: mapped.userMessage,
          classification: mapped.classification,
        };
        return;
      }

      yield* fullStreamToStreamEvent(fullStream);
    } catch (err) {
      const mapped = mapAiSdkErrorToLvis(err);
      yield {
        type: "error",
        error: mapped.userMessage,
        classification: mapped.classification,
      };
    }
  }
}

function buildTools(
  schemas: ToolSchema[] | undefined,
): Record<string, ReturnType<typeof tool>> | undefined {
  if (!schemas || schemas.length === 0) return undefined;
  const out: Record<string, ReturnType<typeof tool>> = {};
  for (const s of schemas) {
    out[s.name] = tool({
      description: s.description,
      inputSchema: jsonSchema(s.inputSchema as never),
    });
  }
  return out;
}
