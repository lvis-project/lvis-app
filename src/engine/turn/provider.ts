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
import { stripSuggestedReplies } from "../suggested-replies.js";
import { t } from "../../i18n/index.js";

export const AI_PROVIDER_PING_TIMEOUT_MS = 8_000;

export function buildProvider(deps: ConversationLoopDeps): LLMProvider | null {
    const llmSettings = deps.settingsService.get("llm");
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
    return provider?.vendor ?? "none";
}

export async function generateText(
  provider: LLMProvider | null,
  settingsService: SettingsService,
  prompt: string,
  systemPrompt = t("be_conversationLoop.generateTextSystemPrompt"),
  abortSignal?: AbortSignal,
): Promise<string> {
    if (!provider) throw new Error("LLM provider not configured");
    if (abortSignal?.aborted) throw new Error("LLM generation aborted");
    let text = "";
    const llm = settingsService.get("llm");
    const block = getLlmVendorSettings(llm.vendors, llm.provider);
    for await (const ev of provider.streamTurn({
      systemPrompt,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      model: block.model,
      abortSignal,
    })) {
      if (abortSignal?.aborted) throw new Error("LLM generation aborted");
      if (ev.type === "text_delta" && ev.text) text += ev.text;
      if (ev.type === "message_complete") break;
      if (ev.type === "error") throw new Error(`LLM stream error: ${ev.error}`);
    }
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
    const vendor = llm.provider;
    const model = getLlmVendorSettings(llm.vendors, vendor).model;
    if (!provider) {
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
