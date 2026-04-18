/**
 * VercelUnifiedProvider — P0 stub.
 *
 * Per docs/references/vercel-ai-sdk-migration.md §5.2, this is the single
 * adapter that will replace claude-provider/openai-provider/gemini-provider
 * once phases P1-P3 land.
 *
 * Current status (P0): inert scaffold. Feature flag defaults to "none";
 * instantiation is gated behind `settings.llm.useVercelSdk`. `streamTurn`
 * throws on call so any accidental wiring is caught loudly.
 *
 * TODO(P1): Implement Anthropic path (claude vendor)
 *   - message-mapper: GenericMessage → ModelMessage (incl. thinkingBlocks + signature)
 *   - stream-mapper: streamText.fullStream → StreamEvent (reasoning-delta, text-delta, tool-call, finish)
 *   - cache-control providerMetadata (see probe-anthropic-cache.test.ts baseline)
 * TODO(P2): Implement OpenAI path (gpt-5.x via /v1/responses auto-routing)
 * TODO(P3): Implement Gemini path + error-mapper wiring + full L1-L4 snapshot parity
 */
import type {
  LLMProvider,
  LLMVendor,
  StreamEvent,
  StreamTurnParams,
} from "../types.js";

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

  // eslint-disable-next-line require-yield
  async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
    throw new Error(
      "VercelUnifiedProvider: not yet implemented (P0 stub). " +
        "Set settings.llm.useVercelSdk='none' or leave unset.",
    );
  }
}
