/**
 * LLM Pricing + Context Window Registry — Sprint 4.B (Observability)
 *
 * Thin Node-side layer over `src/shared/pricing-data.ts`. The shared module
 * holds the vendor/model/$-rate table (browser-safe, no Node-only imports) so
 * the renderer can import the same prices. This module layers env-override
 * logic via `LVIS_PRICING_OVERRIDE` JSON on top.
 *
 * Values reflect publicly-announced list prices (2026-04). Free/unknown → 0.
 */
import type { LLMVendor } from "./types.js";
import {
  DEFAULT_PRICING,
  FALLBACK_PRICING,
  lookupPricing,
  type ModelPricing,
} from "../../shared/pricing-data.js";

export type { ModelPricing };

let cachedOverride: Record<LLMVendor, Record<string, ModelPricing>> | null = null;
let cachedOverrideEnv: string | undefined = undefined;

function getOverride(): Record<LLMVendor, Record<string, ModelPricing>> | null {
  const raw = process.env.LVIS_PRICING_OVERRIDE;
  if (raw === cachedOverrideEnv) return cachedOverride;
  cachedOverrideEnv = raw;
  if (!raw) { cachedOverride = null; return null; }
  try {
    cachedOverride = JSON.parse(raw) as Record<LLMVendor, Record<string, ModelPricing>>;
  } catch {
    cachedOverride = null;
  }
  return cachedOverride;
}

export function getModelPricing(vendor: LLMVendor, model: string): ModelPricing {
  const override = getOverride();
  const overridden = override?.[vendor]?.[model];
  if (overridden) return overridden;
  // Shared lookup (exact → prefix → FALLBACK_PRICING).
  const base = lookupPricing(vendor, model);
  if (base !== FALLBACK_PRICING) return base;
  return FALLBACK_PRICING;
}

/**
 * Per-turn token usage as fed to {@link computeCost}.
 *
 * IMPORTANT: `inputTokens` carries PROVIDER-RAW semantics, which differ:
 *   - Anthropic: `input_tokens` 는 fresh-only — cache 토큰은 별도 필드.
 *     총 effective input = input + cache_read + cache_write.
 *   - OpenAI / Gemini: `prompt_tokens` / `promptTokenCount` 는 cached 를
 *     이미 포함. cacheReadTokens 가 들어와도 prompt 안의 *부분집합* 으로
 *     읽어야 하며, 별도로 합산하면 double-count.
 *
 * Adapters MUST normalize their provider's shape into this convention
 * BEFORE calling computeCost. See `reference_token_session_4source.md` §1
 * for the per-vendor field mapping.
 */
export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Compute cost (USD) for one turn of usage against per-1M pricing.
 *
 * The vendor argument selects how `inputTokens` and the cache fields
 * combine — see {@link UsageForCost} for the semantic asymmetry between
 * Anthropic (cache-additive) and OpenAI / Gemini (cache-included).
 */
export function computeCost(
  usage: UsageForCost,
  pricing: ModelPricing,
  vendor: LLMVendor,
): number {
  const safe = (n: number | undefined): number =>
    typeof n === "number" && Number.isFinite(n) ? n : 0;

  const input = safe(usage.inputTokens);
  const output = safe(usage.outputTokens);
  const cacheRead = safe(usage.cacheReadTokens);
  const cacheWrite = safe(usage.cacheWriteTokens);

  const per1M = (tokens: number, rate: number): number =>
    (tokens / 1_000_000) * rate;

  switch (vendor) {
    case "claude": {
      // Anthropic raw shape — `input_tokens` 는 fresh-only. cache 가 가산.
      // 모델별 cache rate 가 pricing 에 명시 안 됐으면 Anthropic 공개
      // 가격 비율 (read 0.1×, write 5m TTL 1.25×) 을 사용. Sonnet/Opus/
      // Haiku 모두 동일 비율이라 ratio 기반 산출이 안전하다.
      const cacheReadRate = pricing.cacheReadPer1M ?? pricing.inputPer1M * 0.1;
      const cacheWriteRate = pricing.cacheWritePer1M ?? pricing.inputPer1M * 1.25;
      return (
        per1M(input, pricing.inputPer1M) +
        per1M(cacheRead, cacheReadRate) +
        per1M(cacheWrite, cacheWriteRate) +
        per1M(output, pricing.outputPer1M)
      );
    }
    case "openai":
    case "copilot":
    case "azure-foundry": {
      // `prompt_tokens` 가 cached 를 이미 포함 — cacheRead 를 또 더하면
      // double-count. cached portion 의 자동 할인 (~50%) 은 provider 빌링
      // 파이프라인에서 처리되며 LVIS 는 list-price 로 근사한다.
      return per1M(input, pricing.inputPer1M) + per1M(output, pricing.outputPer1M);
    }
    case "gemini":
    case "vertex-ai": {
      // `promptTokenCount` 가 cachedContentTokenCount 를 이미 포함. cache
      // write 는 storage-per-hour 과금이라 turn-level cost 와 분리되어
      // 이 함수에서 0 으로 둔다 (별도 cron 합산 예정). vertex-ai 는 기본
      // 배포가 Gemini 인 LVIS 에서는 Gemini 회계로 본다 — 향후 Claude-
      // on-Vertex 를 도입하면 model 인자로 분기 추가.
      return per1M(input, pricing.inputPer1M) + per1M(output, pricing.outputPer1M);
    }
  }
}

export const PRICING_TABLE = DEFAULT_PRICING;
