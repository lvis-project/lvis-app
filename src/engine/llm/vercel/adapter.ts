/**
 * VercelUnifiedProvider.
 *
 * Per docs/references/vercel-ai-sdk-migration.md §5.2, this is the single
 * adapter that will replace claude-provider/openai-provider/gemini-provider
 * once phases P1-P3 land.
 *
 * P1 status: Gemini path implemented.
 * P2 status: OpenAI + Copilot + openai-compatible paths implemented.
 *   - vendor="openai"            → createOpenAI(...).responses(model) for gpt-5/o-series
 *                                  (Responses API auto-routing) and .chat() for legacy models.
 *   - vendor="copilot"           → createOpenAI({ baseURL }).chat(model) (Chat Completions only),
 *                                  with reasoning_effort dropped on tool turns (400 guard).
 *   - vendor="openai-compatible" → createOpenAICompatible({ baseURL })(model).
 * P3 status: Claude path still throws.
 *
 * TODO(P3): Implement Claude path (thinkingBlocks + signature + cacheControl).
 */
import { streamText, jsonSchema, tool, type ModelMessage } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
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

/**
 * Vendor slot recognised by VercelUnifiedProvider. Extends LLMVendor with
 * the not-yet-core "openai-compatible" string so the adapter can accept it
 * directly without bloating the core LLMVendor union (that change is
 * tracked separately — settings surface + UI dropdown must follow).
 */
export type VercelVendor = LLMVendor | "openai-compatible";

const COPILOT_BASE_URL = "https://models.github.ai/inference";

/** Detect OpenAI reasoning-model families (Responses API + reasoning_effort support). */
export function isOpenAIReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes("gpt-5") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("o4")
  );
}

/**
 * Map LVIS thinking budget (tokens) to OpenAI reasoning_effort.
 *   budget ≤   500 → "none"    (GPT-5.2+ only; callers ignore for older models)
 *   budget ≤ 3 000 → "low"
 *   budget ≥ 8 000 → "high"
 *   else           → "medium"
 */
export function mapReasoningEffort(
  budget: number,
): "none" | "low" | "medium" | "high" {
  if (budget <= 500) return "none";
  if (budget <= 3000) return "low";
  if (budget >= 8000) return "high";
  return "medium";
}

export class VercelUnifiedProvider implements LLMProvider {
  readonly vendor: LLMVendor;
  private readonly vendorSlot: VercelVendor;
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly customFetch?: typeof fetch;

  constructor(
    vendor: VercelVendor,
    apiKey: string,
    baseUrl?: string,
    customFetch?: typeof fetch,
  ) {
    // Expose a core-compatible vendor on the interface; "openai-compatible"
    // is reported as "openai" so downstream vendor-gated logic keeps working.
    this.vendor = (vendor === "openai-compatible" ? "openai" : vendor) as LLMVendor;
    this.vendorSlot = vendor;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.customFetch = customFetch;
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const slot = this.vendorSlot;
    if (slot === "claude") {
      // Match legacy provider contract: yield an error StreamEvent rather
      // than throwing, so conversation-loop handles all provider failures
      // uniformly. Note: IMPLEMENTED_VENDORS in provider-factory should
      // normally prevent us from ever reaching this branch for "claude"
      // while P3 is pending (safe fallback to legacy).
      yield {
        type: "error",
        error:
          `VercelUnifiedProvider: vendor "claude" not implemented yet (P3). ` +
          "Set settings.llm.useVercelSdk to exclude 'claude'.",
      };
      return;
    }

    try {
      const messages: ModelMessage[] = genericToModelMessages(params.messages);
      const tools = buildTools(params.tools);
      const hasTools = Boolean(tools && Object.keys(tools).length > 0);

      // Per-vendor model resolution.
      const model = this.resolveModel(params.model, hasTools);

      // Reasoning effort (OpenAI family). Only passed through providerOptions
      // when the model actually supports it.
      const budget = params.thinkingBudgetTokens ?? 10_000;
      const reasoningEffort = mapReasoningEffort(budget);
      const isOpenAIReasoning =
        (slot === "openai" || slot === "copilot") &&
        isOpenAIReasoningModel(params.model);

      // Copilot-only guard: Chat Completions returns 400 when reasoning_effort
      // is set alongside tools for gpt-5.x. Drop the flag on tool turns.
      // (OpenAI Responses API does NOT have this restriction.)
      const isGpt5 = params.model.toLowerCase().includes("gpt-5");
      const dropReasoningForCopilotTools =
        slot === "copilot" && isGpt5 && hasTools;

      const useReasoning =
        params.enableThinking === true &&
        isOpenAIReasoning &&
        !dropReasoningForCopilotTools;

      const providerOptions = useReasoning
        ? { openai: { reasoningEffort } }
        : undefined;

      // Wrap streamText() in try/catch to also capture synchronous construction
      // errors (e.g. APICallError thrown pre-stream), not just mid-stream errors.
      let fullStream: AsyncIterable<Record<string, unknown> & { type: string }>;
      try {
        const result = streamText({
          model,
          system: params.systemPrompt,
          messages,
          ...(tools ? { tools } : {}),
          ...(params.maxTokens ? { maxOutputTokens: params.maxTokens } : {}),
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          ...(providerOptions ? { providerOptions } : {}),
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

  private resolveModel(modelId: string, _hasTools: boolean) {
    const slot = this.vendorSlot;

    if (slot === "gemini") {
      const google = createGoogleGenerativeAI({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        ...(this.customFetch ? { fetch: this.customFetch } : {}),
      });
      return google(modelId);
    }

    if (slot === "openai") {
      const openai = createOpenAI({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        ...(this.customFetch ? { fetch: this.customFetch } : {}),
      });
      // Responses API for reasoning families (gpt-5.x / o-series); Chat
      // Completions for legacy gpt-4.x. This matches the Vercel SDK's
      // documented routing and avoids silent 400s on tool turns.
      return isOpenAIReasoningModel(modelId)
        ? openai.responses(modelId)
        : openai.chat(modelId);
    }

    if (slot === "copilot") {
      // GitHub Copilot / Models endpoint speaks Chat Completions only.
      const openai = createOpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl || COPILOT_BASE_URL,
        ...(this.customFetch ? { fetch: this.customFetch } : {}),
      });
      return openai.chat(modelId);
    }

    if (slot === "openai-compatible") {
      if (!this.baseUrl) {
        throw new Error(
          "VercelUnifiedProvider(openai-compatible): baseUrl is required",
        );
      }
      const compat = createOpenAICompatible({
        name: "lvis-compat",
        baseURL: this.baseUrl,
        apiKey: this.apiKey,
        ...(this.customFetch ? { fetch: this.customFetch } : {}),
      });
      return compat(modelId);
    }

    throw new Error(`VercelUnifiedProvider: unknown vendor slot "${slot}"`);
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
