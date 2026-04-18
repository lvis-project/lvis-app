/**
 * Provider Factory — 벤더 설정에 따라 적절한 LLM Provider 생성
 *
 * Vercel AI SDK migration (see docs/references/vercel-ai-sdk-migration.md):
 * when `useVercelSdk` selects the active vendor, route to VercelUnifiedProvider
 * instead of the legacy vendor-specific provider. The flag is expected to be
 * resolved by the caller (conversation-loop) ONCE per conversation, not per
 * turn (migration doc §5.1 principle 5) — passing it per-call here is fine
 * because the caller pins it upfront.
 */
import type { LLMProvider, LLMVendor, ProviderConfig } from "./types.js";
import { ClaudeProvider } from "./claude-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { VercelUnifiedProvider } from "./vercel/adapter.js";

const COPILOT_BASE_URL = "https://models.github.ai/inference";

export type UseVercelSdk = "none" | "gemini" | "openai" | "claude" | "all";

export interface CreateProviderOptions {
  useVercelSdk?: UseVercelSdk;
}

function shouldUseVercel(
  vendor: LLMVendor,
  flag: UseVercelSdk | undefined,
): boolean {
  if (!flag || flag === "none") return false;
  if (flag === "all") return vendor !== "copilot"; // copilot stays on legacy OpenAI path for now
  return flag === vendor;
}

export function createProvider(
  config: ProviderConfig,
  options: CreateProviderOptions = {},
): LLMProvider {
  // Feature flag: evaluate once-per-conversation upstream; we just honour the
  // resolved value here. Do NOT read settings inside per-turn call paths.
  if (shouldUseVercel(config.vendor, options.useVercelSdk)) {
    return new VercelUnifiedProvider(config.vendor, config.apiKey, config.baseUrl);
  }

  switch (config.vendor) {
    case "claude":
      return new ClaudeProvider(config.apiKey);

    case "openai":
      return new OpenAIProvider(config.apiKey, "openai", config.baseUrl);

    case "copilot":
      return new OpenAIProvider(config.apiKey, "copilot", config.baseUrl ?? COPILOT_BASE_URL);

    case "gemini":
      return new GeminiProvider(config.apiKey);


    default:
      throw new Error(`지원하지 않는 LLM 벤더: ${config.vendor}`);
  }
}

/** 벤더별 API 키 시크릿 키 이름 */
export function secretKeyFor(vendor: LLMVendor): string {
  return `llm.apiKey.${vendor}`;
}
