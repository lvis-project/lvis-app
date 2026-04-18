/**
 * Provider Factory — 벤더 설정에 따라 적절한 LLM Provider 생성
 */
import type { LLMProvider, LLMVendor, ProviderConfig } from "./types.js";
import { ClaudeProvider } from "./claude-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import { GeminiProvider } from "./gemini-provider.js";

const COPILOT_BASE_URL = "https://models.github.ai/inference";

export function createProvider(config: ProviderConfig): LLMProvider {
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
