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
import type { AiProviderPingResult } from "../../shared/ai-provider-ping.js";
import type { ConversationLoopDeps } from "./types.js";
import { stripSuggestedReplies } from "../suggested-replies.js";
import { t } from "../../i18n/index.js";

export const AI_PROVIDER_PING_TIMEOUT_MS = 8_000;

export function buildProvider(deps: ConversationLoopDeps): LLMProvider | null {
    const llmSettings = deps.settingsService.get("llm");
    const vendor = llmSettings.provider;
    const block = llmSettings.vendors[vendor];
    const apiKey = deps.settingsService.getSecret(secretKeyFor(vendor));

    // Vertex AI uses service account / ADC — apiKey not required, but project is.
    const isVertex = vendor === "vertex-ai";
    if (!apiKey && !isVertex) {
      return null;
    }
    if (isVertex && !block.vertexProject && !process.env.GOOGLE_CLOUD_PROJECT && !process.env.GCLOUD_PROJECT) {
      return null;
    }

    try {
      const createLoopProvider = (config: ProviderConfig): LLMProvider =>
        createProvider({
          ...config,
          ...(config.vendor === "azure-foundry" && deps.llmFetch
            ? { fetch: deps.llmFetch }
            : {}),
        });

      const primary = createLoopProvider({
        vendor,
        apiKey: apiKey ?? "",
        // Sub-agent model override takes precedence over the vendor block's
        // configured model; falls back to block.model when no override is set
        // (parent loops and sub-agents without a resolved profile model).
        model: deps.modelOverride ?? block.model,
        ...(block.baseUrl ? { baseUrl: block.baseUrl } : {}),
        ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
        ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
      });
      const chain = llmSettings.fallbackChain
        .filter((e) => e.provider && e.model)
        .map((entry) => {
          const fallbackBlock = llmSettings.vendors[entry.provider];
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
    for await (const ev of provider.streamTurn({
      systemPrompt,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      model: llm.vendors[llm.provider].model,
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
    const model = llm.vendors[vendor]?.model ?? "";
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
