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
import type { LLMUseVercelSdk } from "../../data/settings-store.js";

const COPILOT_BASE_URL = "https://models.github.ai/inference";

/** Extra config for vendors that need more than (apiKey, baseUrl). */
export interface VertexConfig {
  project?: string;
  location?: string;
}

/** @deprecated Use `LLMUseVercelSdk` from settings-store instead. Kept as alias for backwards compat. */
export type UseVercelSdk = LLMUseVercelSdk;

export interface CreateProviderOptions {
  useVercelSdk?: LLMUseVercelSdk;
}

/**
 * Vendors for which VercelUnifiedProvider is fully implemented in the current
 * phase. If the flag selects a vendor whose path hasn't landed yet, we fall
 * back to the legacy provider silently rather than yielding an error at turn time.
 *
 * State: six supported vendors (claude, openai, gemini, copilot, azure-foundry, vertex-ai).
 * Legacy-capable: gemini (P1), openai/copilot (P2), claude (P3).
 * Vercel-only:    azure-foundry, vertex-ai (no legacy provider equivalent).
 */
const IMPLEMENTED_VENDORS: ReadonlySet<LLMVendor> = new Set<LLMVendor>([
  "gemini",
  "openai",
  "copilot",
  "claude",
  "azure-foundry",
  "vertex-ai",
]);

/**
 * Vendors that have NO legacy provider equivalent — they MUST route through
 * VercelUnifiedProvider regardless of the `useVercelSdk` flag setting.
 */
const VERCEL_ONLY_VENDORS: ReadonlySet<LLMVendor> = new Set<LLMVendor>([
  "azure-foundry",
  "vertex-ai",
]);

function shouldUseVercel(
  vendor: LLMVendor,
  flag: LLMUseVercelSdk | undefined,
): boolean {
  // Vercel-only vendors bypass the flag — there is no legacy path to fall back to.
  if (VERCEL_ONLY_VENDORS.has(vendor)) return true;
  if (!flag || flag === "none") return false;
  // Safety gate: fall back to legacy if this vendor's Vercel path isn't wired yet.
  if (!IMPLEMENTED_VENDORS.has(vendor)) return false;
  // P3: "all" covers all vendors now that Claude path has landed.
  if (flag === "all") return true;
  // P2: openai flag covers both "openai" and "copilot" (shared adapter path).
  if (flag === "openai") return vendor === "openai" || vendor === "copilot";
  return flag === vendor;
}

export function createProvider(
  config: ProviderConfig,
  options: CreateProviderOptions = {},
): LLMProvider {
  // Feature flag: evaluate once-per-conversation upstream; we just honour the
  // resolved value here. Do NOT read settings inside per-turn call paths.
  if (shouldUseVercel(config.vendor, options.useVercelSdk)) {
    // Copilot needs its default baseUrl when none is configured so the
    // Vercel adapter hits the right endpoint.
    const baseUrl =
      config.vendor === "copilot"
        ? (config.baseUrl ?? COPILOT_BASE_URL)
        : config.baseUrl;
    return new VercelUnifiedProvider(config.vendor, config.apiKey, baseUrl, undefined, {
      vertexProject: config.vertexProject,
      vertexLocation: config.vertexLocation,
    });
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

    case "azure-foundry":
    case "vertex-ai":
      // Should have been routed via shouldUseVercel() above — defensive fallback.
      return new VercelUnifiedProvider(config.vendor, config.apiKey, config.baseUrl, undefined, {
        vertexProject: config.vertexProject,
        vertexLocation: config.vertexLocation,
      });

    default:
      throw new Error(`지원하지 않는 LLM 벤더: ${config.vendor}`);
  }
}

/** 벤더별 API 키 시크릿 키 이름 */
export function secretKeyFor(vendor: LLMVendor): string {
  return `llm.apiKey.${vendor}`;
}
