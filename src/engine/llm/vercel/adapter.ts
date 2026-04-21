/**
 * Vercel AI SDK unified adapter. Single LLM provider since P4 migration
 * (2026-04-xx) — replaces per-vendor claude/openai/gemini implementations.
 */
import { streamText, jsonSchema, smoothStream, tool, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
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
  if (budget > 8000) return "high";
  return "medium";
}

/**
 * Map LVIS thinking budget (tokens) to Anthropic adaptive-thinking effort.
 *   budget ≤ 3 000 → "low"
 *   budget ≤ 6 000 → "medium"
 *   budget ≤ 16 000 → "high"
 *   budget >  16 000 → "max"
 * Used for claude-4.x adaptive thinking. claude-3.x uses `budgetTokens` directly.
 */
export function mapBudgetToEffort(
  budget: number,
): "low" | "medium" | "high" | "max" {
  if (budget <= 3000) return "low";
  if (budget <= 6000) return "medium";
  if (budget <= 16_000) return "high";
  return "max";
}

/**
 * Detect Claude families that support adaptive thinking (≥ v4).
 *
 * Version-parse so claude-5.x (and later) are future-proofed automatically.
 * Matches:
 *   claude-sonnet-4-20260101 → major 4
 *   claude-opus-4            → major 4
 *   claude-5-sonnet-...      → major 5
 *   claude-5                 → major 5
 * Non-matches (→ budget-based "enabled" thinking):
 *   claude-3-5-sonnet-latest, claude-3-opus-20240229
 */
export function supportsAdaptiveThinking(modelId: string): boolean {
  const m = modelId.toLowerCase();
  const match = m.match(/claude-[a-z]+-(\d+)/) || m.match(/claude-(\d+)/);
  if (!match) return false;
  return parseInt(match[1]!, 10) >= 4;
}

/** @deprecated use supportsAdaptiveThinking — kept for backward compat. */
export const isClaude4Family = supportsAdaptiveThinking;

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

export interface VercelProviderExtras {
  /** Vertex AI — GCP project ID (required when vendor="vertex-ai"). */
  vertexProject?: string;
  /** Vertex AI — GCP region (default "us-central1"). */
  vertexLocation?: string;
}

export class VercelUnifiedProvider implements LLMProvider {
  private static warnedCompatThinking = false;
  private static warnedReasoningSamplingDrop = false;
  readonly vendor: LLMVendor;
  private readonly vendorSlot: VercelVendor;
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly customFetch?: typeof fetch;
  private readonly extras: VercelProviderExtras;

  constructor(
    vendor: VercelVendor,
    apiKey: string,
    baseUrl?: string,
    customFetch?: typeof fetch,
    extras: VercelProviderExtras = {},
  ) {
    // Expose a core-compatible vendor on the interface; "openai-compatible"
    // is reported as "openai" so downstream vendor-gated logic keeps working.
    // "azure-foundry" and "vertex-ai" are first-class LLMVendor values.
    this.vendor = (vendor === "openai-compatible" ? "openai" : vendor) as LLMVendor;
    this.vendorSlot = vendor;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.customFetch = customFetch;
    this.extras = extras;
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const slot = this.vendorSlot;

    try {
      const messages: ModelMessage[] = genericToModelMessages(params.messages, this.vendor);
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

      // Guard: Chat Completions returns 400 when reasoning_effort is set
      // alongside tools for gpt-5.x. Drop the flag on tool turns for:
      //   - copilot (always Chat Completions)
      //   - openai with a custom baseUrl (may point at a Chat-Completions proxy
      //     that cannot be assumed to support Responses API).
      // Native OpenAI (no baseUrl override) uses Responses API and has no such
      // restriction.
      const isGpt5 = params.model.toLowerCase().includes("gpt-5");
      const suppressReasoningForToolTurn =
        (slot === "copilot" && isGpt5 && hasTools) ||
        (slot === "openai" && Boolean(this.baseUrl) && isGpt5 && hasTools);

      // One-shot warn: openai-compatible silently ignores enableThinking.
      if (
        slot === "openai-compatible" &&
        params.enableThinking === true &&
        !VercelUnifiedProvider.warnedCompatThinking
      ) {
        VercelUnifiedProvider.warnedCompatThinking = true;
        console.warn(
          "[VercelUnifiedProvider] enableThinking=true is silently ignored " +
            "for vendor=openai-compatible (endpoint does not expose reasoning_effort).",
        );
      }

      const useReasoning =
        params.enableThinking === true &&
        isOpenAIReasoning &&
        !suppressReasoningForToolTurn;

      // `reasoningSummary: 'detailed'` makes the Responses API stream
      // `response.reasoning_summary_text.delta` events — without it the model
      // reasons silently and the UI ReasoningCard never populates. This is
      // what enables the "think → tool → think" UX per the migration doc §4 row 6.
      let providerOptions: Record<string, Record<string, unknown>> | undefined =
        useReasoning
          ? { openai: { reasoningEffort, reasoningSummary: "detailed" } }
          : undefined;

      // Anthropic-specific wiring: adaptive (4.x) vs budget-based (3.x) thinking
      // plus interleaved-thinking beta header when thinking+tools coincide.
      let headers: Record<string, string> | undefined;
      if (slot === "claude") {
        const thinkingEnabled = params.enableThinking === true;
        const anthropicOpts: Record<string, unknown> = {};
        if (thinkingEnabled) {
          if (supportsAdaptiveThinking(params.model)) {
            anthropicOpts.thinking = {
              type: "adaptive",
              effort: mapBudgetToEffort(budget),
            };
          } else {
            anthropicOpts.thinking = {
              type: "enabled",
              budgetTokens: budget,
            };
          }
        }
        if (Object.keys(anthropicOpts).length > 0) {
          providerOptions = { ...(providerOptions ?? {}), anthropic: anthropicOpts };
        }
        if (thinkingEnabled && hasTools) {
          headers = { "anthropic-beta": INTERLEAVED_THINKING_BETA };
        }
      }

      // Sprint A: vendor-agnostic generation controls. `maxOutputTokens` takes
      // precedence over legacy `maxTokens` when provided.
      const effectiveMaxOutputTokens = params.maxOutputTokens ?? params.maxTokens;

      // OpenAI reasoning models on the **Responses API** reject sampling
      // controls (temperature, seed) — passing them surfaces an "AI SDK
      // Warning" AND (depending on SDK version) an APICallError that
      // terminates the stream mid-turn. Only the native OpenAI slot routes
      // through `openai.responses()` (see resolveModel:337-339); the Copilot
      // slot always uses Chat Completions and accepts temperature/seed, so we
      // must not drop for copilot. stopSequences is kept — Responses API
      // accepts it.
      const dropSamplingParams =
        slot === "openai" && isOpenAIReasoningModel(params.model);
      if (
        dropSamplingParams &&
        (params.temperature !== undefined || params.seed !== undefined) &&
        !VercelUnifiedProvider.warnedReasoningSamplingDrop
      ) {
        VercelUnifiedProvider.warnedReasoningSamplingDrop = true;
        console.warn(
          "[VercelUnifiedProvider] OpenAI Responses API does not support " +
            "temperature/seed on reasoning models — dropping before dispatch.",
        );
      }

      // Sprint A: map responseFormat → providerOptions per vendor (JSON mode).
      if (params.responseFormat) {
        const rf = params.responseFormat;
        const isJson =
          rf === "json" ||
          (typeof rf === "object" && rf.type === "json-schema");
        if (isJson) {
          providerOptions = providerOptions ?? {};
          if (slot === "openai" || slot === "copilot" || slot === "openai-compatible" || slot === "azure-foundry") {
            providerOptions.openai = {
              ...(providerOptions.openai ?? {}),
              responseFormat: { type: "json_object" },
            };
          } else if (slot === "gemini" || slot === "vertex-ai") {
            providerOptions.google = {
              ...(providerOptions.google ?? {}),
              responseMimeType: "application/json",
            };
          }
          // Claude: JSON mode is prompt-driven; no provider flag.
        }
      }

      // Sprint A: smoothStream transform (Vercel path only).
      // `"word"` uses Vercel's built-in word chunker; `"char"` uses a regex
      // that matches one code point per chunk.
      const smoothing = params.streamSmoothing;
      const transform =
        smoothing === "word"
          ? smoothStream({ chunking: "word" })
          : smoothing === "char"
            ? smoothStream({ chunking: /./u })
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
          ...(effectiveMaxOutputTokens ? { maxOutputTokens: effectiveMaxOutputTokens } : {}),
          ...(!dropSamplingParams && params.temperature !== undefined
            ? { temperature: params.temperature }
            : {}),
          ...(!dropSamplingParams && params.seed !== undefined
            ? { seed: params.seed }
            : {}),
          ...(params.stopSequences && params.stopSequences.length > 0
            ? { stopSequences: params.stopSequences }
            : {}),
          ...(transform ? { experimental_transform: transform } : {}),
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          ...(providerOptions
            ? {
                providerOptions: providerOptions as Parameters<
                  typeof streamText
                >[0]["providerOptions"],
              }
            : {}),
          ...(headers ? { headers } : {}),
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

    if (slot === "claude") {
      const anthropic = createAnthropic({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        ...(this.customFetch ? { fetch: this.customFetch } : {}),
      });
      return anthropic.languageModel(modelId);
    }

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

    if (slot === "azure-foundry") {
      // Azure AI Foundry exposes an OpenAI-compatible surface on a per-deployment
      // endpoint like https://{resource}.openai.azure.com/openai/deployments/{deployment}/.
      // Route through createOpenAICompatible so we don't add Azure SDK to legacy paths.
      if (!this.baseUrl) {
        throw new Error(
          "VercelUnifiedProvider(azure-foundry): baseUrl is required " +
            "(e.g. https://{resource}.openai.azure.com/openai/deployments/{deployment}/)",
        );
      }
      // Normalize user-supplied URL: strip any trailing /chat/completions path and
      // extract api-version query param so the SDK can append the path cleanly.
      // Users sometimes copy the full endpoint URL including path + query string.
      const parsedUrl = new URL(this.baseUrl);
      const apiVersion = parsedUrl.searchParams.get("api-version") ?? undefined;
      parsedUrl.search = "";
      const cleanBaseUrl = parsedUrl.toString().replace(/\/chat\/completions\/?$/, "/");
      // gpt-5.x family requires max_completion_tokens instead of max_tokens.
      // Intercept the request body to swap the field name transparently.
      const isGpt5Model = /gpt-5/i.test(modelId);
      const baseFetch = this.customFetch ?? fetch;
      const azureFetch: typeof fetch = isGpt5Model
        ? async (input, init) => {
            if (init?.body && typeof init.body === "string") {
              try {
                const body = JSON.parse(init.body) as Record<string, unknown>;
                if ("max_tokens" in body) {
                  body.max_completion_tokens = body.max_tokens;
                  delete body.max_tokens;
                  init = { ...init, body: JSON.stringify(body) };
                }
              } catch {
                // leave body unchanged if parse fails
              }
            }
            return baseFetch(input, init);
          }
        : baseFetch;
      const azure = createOpenAICompatible({
        name: "azure-foundry",
        baseURL: cleanBaseUrl,
        apiKey: this.apiKey,
        ...(apiVersion ? { queryParams: { "api-version": apiVersion } } : {}),
        fetch: azureFetch,
      });
      return azure(modelId);
    }

    if (slot === "vertex-ai") {
      // Google Vertex AI — requires GCP project + location. Auth flows via
      // service account: either GOOGLE_APPLICATION_CREDENTIALS env, or
      // Application Default Credentials (gcloud auth application-default login).
      const project =
        this.extras.vertexProject ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT;
      if (!project) {
        throw new Error(
          "VercelUnifiedProvider(vertex-ai): project is required " +
            "(set settings.llm.vertexProject or GOOGLE_CLOUD_PROJECT env)",
        );
      }
      const location = this.extras.vertexLocation || "us-central1";
      const vertex = createVertex({
        project,
        location,
        ...(this.customFetch ? { fetch: this.customFetch } : {}),
      });
      return vertex(modelId);
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
