/**
 * Provider Factory — always routes through VercelUnifiedProvider.
 *
 * Vercel AI SDK migration P4 (see docs/references/vercel-migration-baseline.md):
 * the per-vendor legacy providers and the feature flag have been removed.
 * `VercelUnifiedProvider` is the sole path for all supported vendors.
 */
import type { LLMProvider, LLMVendor, ProviderConfig } from "./types.js";
import { VercelUnifiedProvider } from "./vercel/adapter.js";

const COPILOT_BASE_URL = "https://models.github.ai/inference";

/** Extra config for vendors that need more than (apiKey, baseUrl). */
export interface VertexConfig {
  project?: string;
  location?: string;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  // Copilot needs its default baseUrl when none is configured so the
  // Vercel adapter hits the right endpoint.
  const baseUrl =
    config.vendor === "copilot"
      ? (config.baseUrl ?? COPILOT_BASE_URL)
      : config.baseUrl;

  return new VercelUnifiedProvider(
    config.vendor,
    config.apiKey,
    baseUrl,
    undefined,
    {
      vertexProject: config.vertexProject,
      vertexLocation: config.vertexLocation,
    },
  );
}

/** 벤더별 API 키 시크릿 키 이름 */
export function secretKeyFor(vendor: LLMVendor): string {
  return `llm.apiKey.${vendor}`;
}
