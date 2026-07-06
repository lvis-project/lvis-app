/**
 * Vercel AI SDK unified adapter. Single LLM provider since P4 migration
 * (2026-04-xx) — replaces per-vendor claude/openai/gemini implementations.
 */
import { streamText, jsonSchema, smoothStream, tool, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  GenericMessage,
  LLMProvider,
  LLMVendor,
  StreamEvent,
  StreamTurnParams,
  ToolSchema,
} from "../types.js";
import { isOpenAICompatibleVendor } from "../../../shared/llm-vendor-defaults.js";
import { genericToModelMessages } from "./message-mapper.js";
import { fullStreamToStreamEvent } from "./stream-mapper.js";
import { mapAiSdkErrorToLvis } from "./error-mapper.js";
import { lookupPricing } from "../../../shared/pricing-data.js";
import {
  normalizeProviderToolAliasText,
  OPENAI_RESPONSES_TOOL_SEARCH_ALIAS,
  PROVIDER_TOOL_SEARCH_TEXT_ALIASES,
} from "../../../shared/tool-name-aliases.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../../tools/registry.js";

/** Vendor slot recognised by VercelUnifiedProvider. */
export type VercelVendor = LLMVendor;

const COPILOT_BASE_URL = "https://models.github.ai/inference";
/**
 * Provider name handed to `createOpenAICompatible({ name })`. The @ai-sdk
 * openai-compatible model derives `providerOptionsName` from this (the part
 * before the first "."), and forwards any *unknown* keys under
 * `providerOptions[name]` straight into the HTTP request body. We use that
 * passthrough to ship vLLM's `chat_template_kwargs` per request. Keep the
 * createOpenAICompatible `name` and the providerOptions key in lockstep via
 * this single constant — a drift would silently drop the thinking toggle.
 */
const OPENAI_COMPAT_PROVIDER_NAME = "lvis-compat";
// Tool-name aliases applied ONLY on the OpenAI Responses wire. Keep this to
// HOST builtins (tool_search) — never alias a plugin/MCP tool here. The
// provider-as-oracle guard (engine/llm/rejected-tool-schema.ts) drops a
// rejected tool by matching the provider error against REGISTRY names; if a
// third-party tool were aliased, a strict-mode 400 would name the alias and the
// oracle would miss it on this wire. tool_search is host-controlled and never
// 400s, so the current single entry is safe.
const OPENAI_RESPONSES_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  [TOOL_SEARCH_TOOL_NAME]: OPENAI_RESPONSES_TOOL_SEARCH_ALIAS,
};
const OPENAI_RESPONSES_TOOL_NAME_ALIAS_REVERSE: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(OPENAI_RESPONSES_TOOL_NAME_ALIASES).map(([from, to]) => [
      to,
      from,
    ]),
  );
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

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const CONTEXT_1M_BETA = "context-1m-2025-08-07";

export function normalizeAzureFoundryBaseURL(rawBaseUrl: string): string {
  const parsedUrl = new URL(rawBaseUrl);
  parsedUrl.search = "";
  parsedUrl.hash = "";

  let pathname = parsedUrl.pathname.replace(/\/+$/, "");
  const openaiIndex = pathname.indexOf("/openai");
  if (openaiIndex >= 0) {
    pathname = `${pathname.slice(0, openaiIndex)}/openai`;
  } else if (parsedUrl.hostname.endsWith(".openai.azure.com")) {
    pathname = "/openai";
  }

  parsedUrl.pathname = pathname || "/";
  return parsedUrl.toString().replace(/\/$/, "");
}

function assertCredentialedBaseUrlUsesHttps(
  vendor: VercelVendor,
  baseUrl: string | undefined,
  apiKey: string,
): void {
  if (!baseUrl || !apiKey) return;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `VercelUnifiedProvider(${vendor}): credentialed baseUrl must use https`,
    );
  }
}

export interface VercelProviderExtras {
  /** Vertex AI — GCP project ID (required when vendor="vertex-ai"). */
  vertexProject?: string;
  /** Vertex AI — GCP region (default "us-central1"). */
  vertexLocation?: string;
}

export class VercelUnifiedProvider implements LLMProvider {
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
    this.vendor = vendor;
    this.vendorSlot = vendor;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.customFetch = customFetch;
    this.extras = extras;
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const slot = this.vendorSlot;

    try {
      const useOpenAIResponsesAliases = usesOpenAIResponsesWire(slot, params.model);
      const messages: ModelMessage[] = genericToModelMessages(
        useOpenAIResponsesAliases
          ? remapGenericMessagesForOpenAIResponses(params.messages)
          : params.messages,
        this.vendor,
      );
      const tools = buildTools(
        useOpenAIResponsesAliases
          ? remapToolSchemasForOpenAIResponses(params.tools)
          : params.tools,
      );
      const hasTools = Boolean(tools && Object.keys(tools).length > 0);

      // Per-vendor model resolution.
      const model = this.resolveModel(params.model, hasTools);

      // Reasoning effort (OpenAI family). Only passed through providerOptions
      // when the model actually supports it.
      const budget = params.thinkingBudgetTokens ?? 10_000;
      const reasoningEffort = mapReasoningEffort(budget);
      const isOpenAIReasoning =
        (slot === "openai" || slot === "copilot" || slot === "azure-foundry") &&
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
          ? {
              [slot === "azure-foundry" ? "azure" : "openai"]: {
                reasoningEffort,
                reasoningSummary: "detailed",
              },
            }
          : undefined;

      // OpenAI-compatible (vLLM/SGLang) reasoning toggle. Standard OpenAI Chat
      // Completions has no reasoning switch, but vLLM honors a per-request
      // `chat_template_kwargs.enable_thinking` that the model's chat template
      // reads. The @ai-sdk openai-compatible provider forwards unknown keys
      // under providerOptions[name] into the request body, so each request
      // carries its own flag — multi-user safe: the server is stateless, so
      // one user with thinking ON and another with it OFF never interfere.
      if (isOpenAICompatibleVendor(slot)) {
        const compatOptions: Record<string, unknown> = {
          chat_template_kwargs: {
            enable_thinking: params.enableThinking === true,
          },
        };
        // finish_reason=length CONTINUATION. The conversation loop appended a
        // partial assistant turn as the FINAL message and set this flag. vLLM's
        // `continue_final_message` re-opens that trailing assistant message and
        // resumes generation with ZERO seam tokens (no role header, no BOS, no
        // re-emitted <think>). It is mutually exclusive with
        // add_generation_prompt, which we pin to false. Both are top-level vLLM
        // body fields that the @ai-sdk openai-compatible provider forwards
        // verbatim from providerOptions[name]. Requires last message
        // role === "assistant" (guaranteed by the loop's wire injection).
        if (params.continuationPrefill === true) {
          compatOptions.continue_final_message = true;
          compatOptions.add_generation_prompt = false;
        }
        providerOptions = {
          ...(providerOptions ?? {}),
          [OPENAI_COMPAT_PROVIDER_NAME]: compatOptions,
        };
      }

      // Anthropic-specific wiring: adaptive (4.x) vs budget-based (3.x) thinking
      // plus beta-header opt-ins (interleaved-thinking when thinking+tools,
      // context-1m for 1M-tier models).
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
        // Beta header set: comma-joined per Anthropic's API convention. We
        // gather them in an array and emit one `anthropic-beta` value.
        const betas: string[] = [];
        if (lookupPricing("claude", params.model).contextWindow1MBeta !== undefined) {
          betas.push(CONTEXT_1M_BETA);
        }
        if (thinkingEnabled && hasTools) {
          betas.push(INTERLEAVED_THINKING_BETA);
        }
        if (betas.length > 0) {
          headers = { "anthropic-beta": betas.join(",") };
        }
      }

      // CTRL simplification: temperature / seed / responseFormat / stopSequences /
      // maxOutputTokens removed. Modern frontier models (GPT-5+, Claude 4+)
      // deprecate fine-grained sampling — vendor SDK defaults govern.

      // smoothStream transform (Vercel path only).
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
          // v7 renamed the system-prompt option `system` → `instructions`
          // (`system` remains a deprecated fallback). The LVIS messages array
          // never carries a system-role message, so the prompt flows solely
          // through this top-level option.
          instructions: useOpenAIResponsesAliases
            ? remapSystemPromptForOpenAIResponses(params.systemPrompt)
            : params.systemPrompt,
          messages,
          ...(tools ? { tools } : {}),
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
        // v7 renamed the full event stream `fullStream` → `stream`
        // (`fullStream` remains a deprecated alias). The local variable and
        // mapper retain the historical name; only the SDK accessor moves.
        fullStream = result.stream as AsyncIterable<
          Record<string, unknown> & { type: string }
        >;
      } catch (syncErr) {
        const mapped = mapAiSdkErrorToLvis(syncErr);
        yield {
          type: "error",
          error: mapped.userMessage,
          classification: mapped.classification,
          providerError: mapped.providerError,
        };
        return;
      }

      const streamEvents = fullStreamToStreamEvent(fullStream);
      const restoredEvents = useOpenAIResponsesAliases
        ? restoreStreamEventsFromOpenAIResponses(streamEvents)
        : streamEvents;
      for await (const event of restoredEvents) {
        yield event;
      }
    } catch (err) {
      const mapped = mapAiSdkErrorToLvis(err);
      yield {
        type: "error",
        error: mapped.userMessage,
        classification: mapped.classification,
        providerError: mapped.providerError,
      };
    }
  }

  private resolveModel(modelId: string, _hasTools: boolean) {
    const slot = this.vendorSlot;
    assertCredentialedBaseUrlUsesHttps(slot, this.baseUrl, this.apiKey);

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

    if (isOpenAICompatibleVendor(slot)) {
      if (!this.baseUrl) {
        throw new Error(
          `VercelUnifiedProvider(${slot}): baseUrl is required`,
        );
      }
      const compat = createOpenAICompatible({
        name: OPENAI_COMPAT_PROVIDER_NAME,
        baseURL: this.baseUrl,
        apiKey: this.apiKey,
        ...(this.customFetch ? { fetch: this.customFetch } : {}),
      });
      return compat(modelId);
    }

    if (slot === "azure-foundry") {
      // Azure AI Foundry uses the v1 Responses API for visible reasoning
      // summaries. Accept older copied deployment/chat-completions URLs at the
      // settings boundary, but normalize them to the resource /openai base URL
      // expected by @ai-sdk/azure.
      if (!this.baseUrl) {
        throw new Error(
          "VercelUnifiedProvider(azure-foundry): baseUrl is required " +
            "(e.g. https://{resource}.openai.azure.com/openai/v1/)",
        );
      }
      const azure = createAzure({
        baseURL: normalizeAzureFoundryBaseURL(this.baseUrl),
        apiKey: this.apiKey,
        ...(this.customFetch ? { fetch: this.customFetch } : {}),
      });
      return azure.responses(modelId);
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

function usesOpenAIResponsesWire(slot: VercelVendor, modelId: string): boolean {
  return slot === "azure-foundry" || (slot === "openai" && isOpenAIReasoningModel(modelId));
}

function toOpenAIResponsesToolName(toolName: string): string {
  return OPENAI_RESPONSES_TOOL_NAME_ALIASES[toolName] ?? toolName;
}

function fromOpenAIResponsesToolName(toolName: string): string {
  return OPENAI_RESPONSES_TOOL_NAME_ALIAS_REVERSE[toolName] ?? toolName;
}

function remapGenericMessagesForOpenAIResponses(
  messages: GenericMessage[],
): GenericMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls) {
      return {
        ...message,
        content: restorePromptTextFromOpenAIResponses(message.content),
        toolCalls: message.toolCalls.map((toolCall) => ({
          ...toolCall,
          name: toOpenAIResponsesToolName(toolCall.name),
        })),
      };
    }
    if (message.role === "assistant") {
      return {
        ...message,
        content: restorePromptTextFromOpenAIResponses(message.content),
      };
    }
    if (message.role === "tool_result" && message.toolName) {
      return {
        ...message,
        toolName: toOpenAIResponsesToolName(message.toolName),
        content: restorePromptTextFromOpenAIResponses(message.content),
      };
    }
    if (message.role === "tool_result") {
      return {
        ...message,
        content: restorePromptTextFromOpenAIResponses(message.content),
      };
    }
    return message;
  });
}

function remapToolSchemasForOpenAIResponses(
  schemas: ToolSchema[] | undefined,
): ToolSchema[] | undefined {
  return schemas?.map((schema) => ({
    ...schema,
    name: toOpenAIResponsesToolName(schema.name),
  }));
}

function remapSystemPromptForOpenAIResponses(systemPrompt: string): string {
  return restorePromptTextFromOpenAIResponses(systemPrompt);
}

function restorePromptTextFromOpenAIResponses(text: string): string {
  return normalizeProviderToolAliasText(text);
}

async function* restoreStreamEventsFromOpenAIResponses(
  events: AsyncIterable<StreamEvent>,
): AsyncIterable<StreamEvent> {
  let bufferedKind: "text_delta" | "reasoning_delta" | null = null;
  const buffers: Record<"text_delta" | "reasoning_delta", string> = {
    text_delta: "",
    reasoning_delta: "",
  };

  const flushBufferedText = (
    kind: "text_delta" | "reasoning_delta",
    final: boolean,
  ): StreamEvent | null => {
    const text = buffers[kind];
    if (text.length === 0) return null;
    let safeLength = final
      ? text.length
      : text.length - longestOpenAIResponseAliasPrefixSuffix(text);
    if (safeLength <= 0) return null;
    if (!final) {
      safeLength = avoidCuttingOpenAIResponseAlias(text, safeLength);
      if (safeLength <= 0) return null;
    }
    const emitText = text.slice(0, safeLength);
    buffers[kind] = text.slice(safeLength);
    const restoredText = restorePromptTextFromOpenAIResponses(emitText);
    return restoredText.length > 0 ? { type: kind, text: restoredText } : null;
  };

  const flushActive = (final: boolean): StreamEvent | null => {
    if (!bufferedKind) return null;
    const event = flushBufferedText(bufferedKind, final);
    if (final) bufferedKind = null;
    return event;
  };

  for await (const event of events) {
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      if (bufferedKind && bufferedKind !== event.type) {
        const flushed = flushActive(true);
        if (flushed) yield flushed;
      }
      bufferedKind = event.type;
      buffers[event.type] += event.text;
      const flushed = flushBufferedText(event.type, false);
      if (flushed) yield flushed;
      continue;
    }

    const flushed = flushActive(true);
    if (flushed) yield flushed;
    yield restoreNonTextStreamEventFromOpenAIResponses(event);
  }

  const flushed = flushActive(true);
  if (flushed) yield flushed;
}

function avoidCuttingOpenAIResponseAlias(text: string, safeLength: number): number {
  let adjusted = safeLength;
  const lower = text.toLowerCase();
  for (const alias of PROVIDER_TOOL_SEARCH_TEXT_ALIASES) {
    const needle = alias.toLowerCase();
    let index = lower.indexOf(needle);
    while (index >= 0) {
      const end = index + needle.length;
      if (index < adjusted && end > adjusted) {
        adjusted = index;
      }
      index = lower.indexOf(needle, index + 1);
    }
  }
  return adjusted;
}

function longestOpenAIResponseAliasPrefixSuffix(text: string): number {
  const lower = text.toLowerCase();
  let longest = 0;
  for (const aliasText of PROVIDER_TOOL_SEARCH_TEXT_ALIASES) {
    const alias = aliasText.toLowerCase();
    const maxLength = Math.min(alias.length - 1, lower.length);
    for (let length = maxLength; length > longest; length--) {
      if (alias.startsWith(lower.slice(lower.length - length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

function restoreNonTextStreamEventFromOpenAIResponses(event: StreamEvent): StreamEvent {
  if (event.type === "tool_call") {
    const restoredName = fromOpenAIResponsesToolName(event.name);
    if (restoredName === event.name) return event;
    return { ...event, name: restoredName };
  }
  return event;
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
