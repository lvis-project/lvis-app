/**
 * LLM provider lifecycle helpers.
 *
 * `buildProvider` (settings -> primary + fallback chain), `generateText`
 * (plugin one-shot), `pingProvider` (status probe), and `resolveVendorName`.
 * Extracted from `conversation-loop.ts`; the class keeps thin delegators that
 * forward `this.provider` / `this.deps`.
 */
import { createProvider, secretKeyFor } from "../llm/provider-factory.js";
import { FallbackProvider } from "../llm/vercel/fallback-chain.js";
import type { LLMProvider, ProviderConfig } from "../llm/types.js";
import type { SettingsService } from "../../data/settings-store.js";
import {
  canUseLlmVendorWithoutApiKey,
  getLlmVendorSettings,
  isOpenAICompatibleVendor,
} from "../../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import type { AiProviderPingResult } from "../../shared/ai-provider-ping.js";
import { selectProviderRuntimeFetch } from "../llm/marketplace-provider-fetch.js";
import type { ConversationLoopDeps } from "./types.js";
import {
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  type ActiveChatRuntime,
  type SubscriptionChatRuntimeSelection,
} from "../../shared/subscription-runtime.js";
import { stripSuggestedReplies } from "../suggested-replies.js";
import { t } from "../../i18n/index.js";
import { estimateTokens } from "../../shared/token-estimate.js";
import { normalizeOutputTokenLimit } from "../llm/output-token-limit.js";

export const AI_PROVIDER_PING_TIMEOUT_MS = 8_000;

/** Optional host-owned constraints for a background one-shot generation. */
export interface GenerateTextOptions {
  /**
   * Maximum generated output tokens requested by an internal background caller.
   * Invalid values are ignored and valid values are clamped before transport.
   */
  outputTokenLimit?: number;
}

/**
 * Keep the generic collector within its estimated token budget when a native
 * transport cannot enforce `outputTokenLimit` itself. No ellipsis is appended:
 * an extra marker could violate the cap.
 */
function truncateTextToOutputTokenLimit(value: string, tokenLimit: number): string {
  if (estimateTokens(value) <= tokenLimit) return value;
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = codePoints.slice(0, midpoint).join("");
    if (estimateTokens(candidate) <= tokenLimit) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return codePoints.slice(0, low).join("");
}

function cleanCodexModelOverride(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  if (
    model.length === 0
    || model.length > MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(model)
  ) {
    return undefined;
  }
  return model;
}

function selectionWithModelOverride(
  selection: SubscriptionChatRuntimeSelection,
  modelOverride: string | undefined,
): SubscriptionChatRuntimeSelection {
  // Only Codex exposes a host-verified model picker. ACP runtimes own their
  // default model, so carrying an agent-profile override across that boundary
  // would fabricate a model selection they do not support.
  if (selection.provider !== "codex") return selection;
  const model = cleanCodexModelOverride(modelOverride);
  return model ? Object.freeze({ ...selection, model }) : selection;
}

/**
 * Proves that a provider belongs to the active authentication boundary.
 *
 * Model equality is deliberately not part of this check: child profiles may
 * select a verified Codex model override while retaining the same
 * subscription-authenticated provider. The guard is about preventing a stale
 * API-key transport from being invoked after subscription activation.
 */
export function providerMatchesActiveChatRuntime(
  provider: LLMProvider | null,
  activeChatRuntime: ActiveChatRuntime | undefined,
): boolean {
  if (!provider) return false;
  if (activeChatRuntime?.kind !== "subscription") {
    return provider.subscriptionRuntime === undefined;
  }
  return provider.subscriptionRuntime?.provider === activeChatRuntime.provider;
}

export function buildProvider(deps: ConversationLoopDeps): LLMProvider | null {
    const llmSettings = deps.settingsService.get("llm");
    const activeChatRuntime = llmSettings.activeChatRuntime;
    if (activeChatRuntime?.kind === "subscription") {
      try {
        const selection = selectionWithModelOverride(activeChatRuntime, deps.modelOverride);
        // A profile model is a transient Codex candidate. Preserve the active
        // parent selection so the main-owned runtime can validate the
        // candidate against its live subscription catalog and fall back only
        // to that parent selection when the candidate is stale or unavailable.
        const fallbackSelection = selection.model === activeChatRuntime.model
          ? undefined
          : activeChatRuntime;
        const candidate = fallbackSelection
          ? deps.subscriptionProviderFactory?.(selection, fallbackSelection) ?? null
          : deps.subscriptionProviderFactory?.(selection) ?? null;
        const marker = candidate?.subscriptionRuntime;
        if (
          !marker
          || marker.provider !== selection.provider
          || marker.model !== selection.model
        ) {
          return null;
        }
        // Subscription transport failures get the same bounded transient
        // retry semantics as API-key providers, but the chain is intentionally
        // empty. This retries only the already-selected subscription runtime:
        // it never consults API-key settings, builds another vendor provider,
        // or lets credentials egress through a fallback path.
        return new FallbackProvider(candidate, [], () => "");
      } catch {
        // A main-owned runtime bootstrap failure must never fall through to an
        // API-key provider selected before subscription chat was enabled.
        return null;
      }
    }
    const vendor = llmSettings.provider;
    const block = getLlmVendorSettings(llmSettings.vendors, vendor);
    const hasMarketplaceProviderPresetSelection =
      vendor === "openai-compatible" && Boolean(llmSettings.marketplaceProviderPresetId);
    const marketplaceProviderPreset = hasMarketplaceProviderPresetSelection
      ? (deps.settingsService.get("marketplace").installedProviderPresets ?? [])
        .find((preset) => preset.providerId === llmSettings.marketplaceProviderPresetId)
      : undefined;
    if (hasMarketplaceProviderPresetSelection && !marketplaceProviderPreset) {
      return null;
    }
    const apiKey = deps.settingsService.getSecret(
      marketplaceProviderPreset
        ? marketplaceProviderPresetSecretKey(marketplaceProviderPreset.providerId)
        : secretKeyFor(vendor),
    );
    const effectiveBaseUrl = marketplaceProviderPreset
      ? marketplaceProviderPreset.baseUrl
      : block.baseUrl;

    // Vertex AI uses service account / ADC — apiKey not required, but project is.
    // Self-hosted/local OpenAI-compatible endpoints can also run without an
    // API key when a baseUrl is configured.
    const isVertex = vendor === "vertex-ai";
    const canUseWithoutApiKey = marketplaceProviderPreset
      ? marketplaceProviderPreset.requiresApiKey === false && Boolean(effectiveBaseUrl?.trim())
      : canUseLlmVendorWithoutApiKey(vendor, block);
    if (!apiKey && !isVertex && !canUseWithoutApiKey) {
      return null;
    }
    if (isVertex && !block.vertexProject && !process.env.GOOGLE_CLOUD_PROJECT && !process.env.GCLOUD_PROJECT) {
      return null;
    }

    // Handshake-only providers (openai-compatible family) ship no default model
    // (llm-vendor-defaults CORE_DEFAULT_MODEL["openai-compatible"] === ""). Treat
    // an empty model as "not configured" so we never send a fabricated/seed id
    // the endpoint does not serve — the user selects a model from the live
    // /models handshake list first.
    const effectiveModel = (deps.modelOverride ?? block.model ?? "").trim();
    if (!effectiveModel && isOpenAICompatibleVendor(vendor)) {
      return null;
    }

    const providerApiKey = apiKey ?? "";

    try {
      const createLoopProvider = (config: ProviderConfig): LLMProvider => {
        const providerFetch = selectProviderRuntimeFetch({
          vendor: config.vendor,
          baseUrl: config.baseUrl,
          providerMetadata: config.providerMetadata,
          llmFetch: deps.llmFetch,
        });
        return createProvider({
          ...config,
          ...(providerFetch ? { fetch: providerFetch } : {}),
        });
      };

      const primary = createLoopProvider({
        vendor,
        apiKey: providerApiKey,
        // Sub-agent model override takes precedence over the vendor block's
        // configured model; falls back to block.model when no override is set
        // (parent loops and sub-agents without a resolved profile model).
        model: effectiveModel,
        ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
        ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
        ...(marketplaceProviderPreset ? { providerMetadata: marketplaceProviderPreset } : {}),
      });
      const chain = llmSettings.fallbackChain
        .filter((e) =>
          e.provider &&
          e.model &&
          !(marketplaceProviderPreset && e.provider === "openai-compatible")
        )
        .map((entry) => {
          const fallbackBlock = getLlmVendorSettings(
            llmSettings.vendors,
            entry.provider,
          );
          return {
            ...entry,
            ...(fallbackBlock?.baseUrl ? { baseUrl: fallbackBlock.baseUrl } : {}),
            ...(fallbackBlock?.vertexProject ? { vertexProject: fallbackBlock.vertexProject } : {}),
            ...(fallbackBlock?.vertexLocation ? { vertexLocation: fallbackBlock.vertexLocation } : {}),
          };
        });
      return new FallbackProvider(
        primary,
        chain,
        (v) => deps.settingsService.getSecret(secretKeyFor(v)) ?? "",
        createLoopProvider,
      );
    } catch {
      return null;
    }
}

export function resolveVendorName(provider: LLMProvider | null): string {
    return provider?.subscriptionRuntime
      ? `subscription:${provider.subscriptionRuntime.provider}`
      : provider?.vendor ?? "none";
}

export async function generateText(
  provider: LLMProvider | null,
  settingsService: SettingsService,
  prompt: string,
  systemPrompt = t("be_conversationLoop.generateTextSystemPrompt"),
  abortSignal?: AbortSignal,
  options?: GenerateTextOptions,
): Promise<string> {
    const llm = settingsService.get("llm");
    if (!provider || !providerMatchesActiveChatRuntime(provider, llm.activeChatRuntime)) {
      throw new Error("LLM provider not configured");
    }
    if (abortSignal?.aborted) throw new Error("LLM generation aborted");
    const outputTokenLimit = normalizeOutputTokenLimit(options?.outputTokenLimit);
    const outputLimitController = outputTokenLimit === undefined
      ? undefined
      : new AbortController();
    const providerAbortSignal = outputLimitController
      ? abortSignal
        ? AbortSignal.any([abortSignal, outputLimitController.signal])
        : outputLimitController.signal
      : abortSignal;
    let outputLimitReached = false;
    let text = "";
    const block = getLlmVendorSettings(llm.vendors, llm.provider);
    const model = provider.subscriptionRuntime
      ? provider.subscriptionRuntime.model ?? "default"
      : block.model;
    try {
    for await (const ev of provider.streamTurn({
      systemPrompt,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      model,
      ...(outputTokenLimit === undefined ? {} : { outputTokenLimit }),
      abortSignal: providerAbortSignal,
    })) {
      if (abortSignal?.aborted) throw new Error("LLM generation aborted");
      if (ev.type === "text_delta" && ev.text) {
        const nextText = text + ev.text;
        if (outputTokenLimit === undefined) {
          text = nextText;
        } else {
          text = truncateTextToOutputTokenLimit(nextText, outputTokenLimit);
          if (
            text.length < nextText.length
            || estimateTokens(text) >= outputTokenLimit
          ) {
            outputLimitReached = true;
            outputLimitController?.abort();
            break;
          }
        }
      }
      if (ev.type === "message_complete") break;
      if (ev.type === "error") throw new Error(`LLM stream error: ${ev.error}`);
    }
    } catch (error) {
      if (!outputLimitReached || abortSignal?.aborted) throw error;
    }
    if (abortSignal?.aborted) throw new Error("LLM generation aborted");
    // Plugins and routines consume generateText() return verbatim — strip the
    // suggested-replies block so it never reaches non-chat-stream callers.
    return stripSuggestedReplies(text).trim();
}

export async function pingProvider(
  provider: LLMProvider | null,
  settingsService: SettingsService,
  timeoutMs = AI_PROVIDER_PING_TIMEOUT_MS,
): Promise<AiProviderPingResult> {
    const llm = settingsService.get("llm");
    const selectedSubscription =
      llm.activeChatRuntime?.kind === "subscription"
        ? llm.activeChatRuntime
        : undefined;
    const subscription = provider?.subscriptionRuntime ?? selectedSubscription;
    const vendor = subscription
      ? `subscription:${subscription.provider}`
      : llm.provider;
    const model = subscription
      ? subscription.model || "default"
      : getLlmVendorSettings(llm.vendors, llm.provider).model;
    if (!provider || !providerMatchesActiveChatRuntime(provider, llm.activeChatRuntime)) {
      return {
        configured: false,
        online: false,
        vendor,
        ...(model ? { model } : {}),
        error: "not-configured",
      };
    }

    const startedAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      for await (const ev of provider.streamTurn({
        systemPrompt: "You are a connectivity probe. Reply with PONG only.",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        model,
        abortSignal: ctrl.signal,
      })) {
        if (ev.type === "error") {
          return {
            configured: true,
            online: false,
            vendor,
            model,
            error: ev.error,
            latencyMs: Date.now() - startedAt,
          };
        }
        if (ev.type === "message_complete") {
          return {
            configured: true,
            online: true,
            vendor,
            model,
            latencyMs: Date.now() - startedAt,
          };
        }
      }
      return {
        configured: true,
        online: false,
        vendor,
        model,
        error: "stream-ended",
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        configured: true,
        online: false,
        vendor,
        model,
        error: ctrl.signal.aborted ? "timeout" : (err as Error).message,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
}
