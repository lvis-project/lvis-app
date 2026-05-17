/**
 * Shared LLM pricing + context-window catalog — single source of truth.
 *
 * Imported by:
 *   - `engine/llm/pricing.ts` (Node-side, layers env-override on top)
 *   - `engine/auto-compact.ts:getModelContextWindow` (engine-side ctx lookup)
 *   - `renderer.tsx` / `ui/renderer/hooks/use-context-budget.ts` (UI denominator)
 *
 * Two distinct values per model:
 *   - `contextWindow`        — default API tier (no beta opt-in).
 *   - `contextWindow1MBeta`  — larger window unlocked by Anthropic's
 *                              `context-1m-2025-08-07` beta header. The
 *                              VercelUnifiedProvider auto-sends this header
 *                              for any Claude model that defines this field
 *                              (`engine/llm/vercel/adapter.ts`), so callers
 *                              should treat the beta value as the *effective*
 *                              window when present.
 *
 * Cache prices (Anthropic only — `cacheReadPer1M` / `cacheWritePer1M`):
 *   Read  ~ 0.1× input,  Write 5m TTL ~ 1.25× input. When omitted, callers
 *   derive ratios at compute time (see `engine/llm/pricing.ts:computeCost`).
 *
 * IMPORTANT: this module must stay pure — no `process.env`, no Node-only
 * imports. All env-override logic lives in `engine/llm/pricing.ts`.
 *
 * Pricing source: list prices announced by each vendor. Free / unknown → 0.
 * Context window source: vendor model docs. Last verified 2026-05.
 */

export type PricingVendor =
  | "claude"
  | "openai"
  | "gemini"
  | "copilot"
  | "azure-foundry"
  | "vertex-ai";

/** $ per 1M tokens, plus context window metadata. */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Default API tier context window in tokens. */
  contextWindow: number;
  /**
   * Cache read price ($/1M tokens). Anthropic only — billed at ~0.1× input
   * for prompt-cached reads. OpenAI / Gemini do not bill cache reads as a
   * separate line item (their `cached_tokens` is already inside `prompt_tokens`).
   * Undefined → caller treats cache reads as ordinary input.
   */
  cacheReadPer1M?: number;
  /**
   * Cache write price ($/1M tokens). Anthropic only — 5m TTL ~1.25× input,
   * 1h TTL ~2× input. This single field assumes the dominant TTL.
   * Undefined → caller treats cache writes as ordinary input.
   */
  cacheWritePer1M?: number;
  /**
   * Beta-tier context window (Anthropic `context-1m-2025-08-07`). When
   * defined, the adapter auto-sends the beta header and the model delivers
   * this larger window. Renderer / engine MUST resolve to this value when
   * present — see {@link effectiveContextWindow}.
   */
  contextWindow1MBeta?: number;
  /**
   * Long-context input surcharge — input tokens BEYOND `surchargeInputThreshold`
   * trigger a session-wide price multiplier on BOTH input + output. Currently
   * applies to OpenAI's gpt-5.4 / gpt-5.4-pro: when prompt > 272K, the full
   * session is billed at 2x input + 1.5x output. Renderer cost badge + cost
   * estimator MUST honor this so users see real billing, not standard-tier
   * understatement (issue #900).
   *
   * Set on per-model basis when the provider documents such a tier. Undefined
   * → standard tier only (no surcharge).
   */
  surchargeInputThreshold?: number;
  surchargeInputMultiplier?: number;
  surchargeOutputMultiplier?: number;
}

/** Default pricing + context catalog. */
export const DEFAULT_PRICING: Record<PricingVendor, Record<string, ModelPricing>> = {
  // ── Anthropic Claude ──────────────────────────────────────────────────────
  // Pricing: https://www.anthropic.com/pricing — list prices verified 2026-04.
  // Context: 4.6 family supports 1M via `context-1m-2025-08-07` beta.
  claude: {
    "claude-sonnet-4-6":           { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000, contextWindow1MBeta: 1_000_000 },
    "claude-sonnet-4-5":           { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000 },
    "claude-sonnet-4-20250514":    { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000 },
    "claude-opus-4-6":             { inputPer1M: 15,   outputPer1M: 75, contextWindow: 200_000, contextWindow1MBeta: 1_000_000 },
    "claude-opus-4-5":             { inputPer1M: 15,   outputPer1M: 75, contextWindow: 200_000 },
    "claude-opus-4-20250514":      { inputPer1M: 15,   outputPer1M: 75, contextWindow: 200_000 },
    "claude-haiku-4-5":            { inputPer1M: 1,    outputPer1M: 5,  contextWindow: 200_000 },
    "claude-haiku-4-5-20251001":   { inputPer1M: 1,    outputPer1M: 5,  contextWindow: 200_000 },
    "claude-3-5-sonnet-20241022":  { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000 },
    "claude-3-5-haiku-20241022":   { inputPer1M: 1,    outputPer1M: 5,  contextWindow: 200_000 },
    "claude-3-opus-20240229":      { inputPer1M: 15,   outputPer1M: 75, contextWindow: 200_000 },
    "claude-3-sonnet-20240229":    { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000 },
    "claude-3-haiku-20240307":     { inputPer1M: 0.25, outputPer1M: 1.25, contextWindow: 200_000 },
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  // Pricing source: https://platform.openai.com/docs/pricing
  // Unknown variant pricing intentionally left at 0 — env override expected.
  openai: {
    // gpt-5.4 family — OpenAI 공식 사양 (developers.openai.com/api/docs/models/gpt-5.4*,
    // openai.com/api/pricing, 2026-05 시점 verify).
    //
    // Long-context surcharge: gpt-5.4 / gpt-5.4-pro 의 1M-class window 는 input>272K
    // 시 *세션 전체* 가 input 2x + output 1.5x 로 우상향 (flat full-session, NOT
    // tiered — 272K 초과한 *순간* 모든 token 이 multiplier 적용). 본 테이블의
    // inputPer1M/outputPer1M 은 standard tier (≤272K) 기준이고, 우상향 multiplier
    // 는 surchargeInput{Threshold|Multiplier} / surchargeOutputMultiplier 필드로
    // 자동 적용됨 — `computeCost` 의 openai/copilot/azure-foundry 분기 참조.
    //
    // gpt-5.4-mini / nano 는 OpenAI spec 상 surcharge 없음 (400K 단일 tier).
    "gpt-5.4":                     { inputPer1M: 2.5,  outputPer1M: 15,  contextWindow: 1_050_000, surchargeInputThreshold: 272_000, surchargeInputMultiplier: 2,   surchargeOutputMultiplier: 1.5 },
    "gpt-5.4-mini":                { inputPer1M: 0.75, outputPer1M: 4.5, contextWindow:   400_000 },
    "gpt-5.4-nano":                { inputPer1M: 0.2,  outputPer1M: 1.25, contextWindow:  400_000 },
    "gpt-5.4-pro":                 { inputPer1M: 30,   outputPer1M: 180, contextWindow: 1_100_000, surchargeInputThreshold: 272_000, surchargeInputMultiplier: 2,   surchargeOutputMultiplier: 1.5 },
    "gpt-5.3":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.3-codex":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.2":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.2-codex":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-reasoning":           { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-pro":                 { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-codex":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-codex-mini":          { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-codex-max":           { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5":                       { inputPer1M: 1.25, outputPer1M: 10, contextWindow:   400_000 },
    "gpt-5-mini":                  { inputPer1M: 1.25, outputPer1M: 10, contextWindow:   400_000 },
    "gpt-5-nano":                  { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-4.1":                     { inputPer1M: 2,    outputPer1M: 8,  contextWindow: 1_000_000 },
    "gpt-4.1-mini":                { inputPer1M: 0.4,  outputPer1M: 1.6, contextWindow: 1_000_000 },
    "gpt-4.1-nano":                { inputPer1M: 0,    outputPer1M: 0,  contextWindow: 1_000_000 },
    "gpt-4.1-2025-04-14":          { inputPer1M: 2,    outputPer1M: 8,  contextWindow: 1_000_000 },
    "o3":                          { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o3-2025-04-16":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o4-mini":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o4-mini-2025-04-24":          { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o1":                          { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o1-mini":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   128_000 },
    "gpt-4o":                      { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   128_000 },
    "gpt-4o-mini":                 { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   128_000 },
    "gpt-4-turbo":                 { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   128_000 },
    "gpt-4-32k":                   { inputPer1M: 0,    outputPer1M: 0,  contextWindow:    32_768 },
    "gpt-4":                       { inputPer1M: 0,    outputPer1M: 0,  contextWindow:     8_192 },
    "gpt-3.5-turbo":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:    16_385 },
  },

  // ── Google Gemini ──────────────────────────────────────────────────────────
  // Pricing: https://ai.google.dev/gemini-api/docs/pricing
  // Free tier reflected as 0/0 (paid tier env-override expected for billing).
  gemini: {
    "gemini-2.5-pro":              { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gemini-2.5-flash":            { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gemini-2.5-flash-lite":       { inputPer1M: 0, outputPer1M: 0, contextWindow:   128_000 },
    "gemini-2.0-flash":            { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_048_576 },
    "gemini-2.0-flash-lite":       { inputPer1M: 0, outputPer1M: 0, contextWindow:   128_000 },
    "gemini-1.5-pro":              { inputPer1M: 0, outputPer1M: 0, contextWindow: 2_097_152 },
    "gemini-1.5-flash":            { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_048_576 },
    "gemini-1.5-flash-8b":         { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_048_576 },
  },

  // ── GitHub Copilot ─────────────────────────────────────────────────────────
  // Billing rolls into Copilot subscription — list prices reported as 0.
  // Routing: github.ai/inference proxies these models.
  copilot: {
    // gpt-5.4 family — pricing 0 (Copilot 구독 billing), contextWindow 는 모델 사양
    // (developers.openai.com/api/docs/models/gpt-5.4*). issue #900: mini 의 1.05M
    // 등록이 stale 이었음 — 공식 400K.
    "gpt-5.4":                     { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_050_000 },
    "gpt-5.4-mini":                { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    // nano/pro defensive add — Copilot 이 미래에 proxy 시 prefix-match fallback
    // 으로 gpt-5.4 (1.05M) 잘못 매치 회피 (ralph round-1 architect WARN).
    "gpt-5.4-nano":                { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.4-pro":                 { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_100_000 },
    "gpt-5.3":                     { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.2":                     { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.1":                     { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.1-codex":               { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.1-codex-mini":          { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.1-codex-max":           { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5":                       { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5-mini":                  { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-4.1":                     { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gpt-4.1-mini":                { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gpt-4o":                      { inputPer1M: 0, outputPer1M: 0, contextWindow:   128_000 },
    "gpt-4o-mini":                 { inputPer1M: 0, outputPer1M: 0, contextWindow:   128_000 },
    "claude-opus-4-6":             { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000, contextWindow1MBeta: 1_000_000 },
    "claude-sonnet-4-6":           { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000, contextWindow1MBeta: 1_000_000 },
    "claude-opus-4-5":             { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000 },
    "claude-sonnet-4-5":           { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000 },
    "claude-haiku-4-5":            { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000 },
  },

  // ── Azure AI Foundry / Vertex AI ───────────────────────────────────────────
  // Deployment-name routed — pricing is account-specific. Populate via env
  // override (`LVIS_PRICING_OVERRIDE`). Without an override every model on
  // these vendors falls through to FALLBACK_PRICING, which means UI ring +
  // token preflight is denominated at 128K regardless of the actual deployment
  // capability — explicit override is REQUIRED for context-window math, not
  // just cost accuracy.
  "azure-foundry": {},
  "vertex-ai": {},
};

export const FALLBACK_PRICING: ModelPricing = {
  inputPer1M: 0,
  outputPer1M: 0,
  contextWindow: 128_000,
};

/**
 * Resolve a pricing entry by exact match, then prefix-match (longest wins —
 * date-suffixed snapshots resolve to their family entry). Returns
 * `FALLBACK_PRICING` on miss so cost / window math always has *some* value
 * to work with (zero pricing + 128K window — conservative).
 *
 * Does NOT consult env overrides. Use `engine/llm/pricing.ts:getModelPricing()`
 * for the override-aware variant.
 */
export function lookupPricing(
  vendor: string,
  model: string,
  table: Record<string, Record<string, ModelPricing>> = DEFAULT_PRICING,
): ModelPricing {
  return lookupPricingOptional(vendor, model, table) ?? FALLBACK_PRICING;
}

/**
 * Strict variant — returns `undefined` on miss instead of `FALLBACK_PRICING`.
 * Use this when the caller needs to distinguish "known model" from
 * "unknown / not in catalog" (e.g., disabling cost-mode toggles in UI when
 * pricing is genuinely unavailable rather than zero-by-fallback).
 */
export function lookupPricingOptional(
  vendor: string,
  model: string,
  table: Record<string, Record<string, ModelPricing>> = DEFAULT_PRICING,
): ModelPricing | undefined {
  const vendorTable = table[vendor] ?? {};
  const exact = vendorTable[model];
  if (exact) return exact;
  let bestKey: string | undefined;
  for (const key of Object.keys(vendorTable)) {
    if (model.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey !== undefined ? vendorTable[bestKey] : undefined;
}

/**
 * Anthropic prompt cache per-1M rates resolved against an explicit pricing
 * entry. When the entry omits `cacheReadPer1M` / `cacheWritePer1M`, the
 * publicly-documented Anthropic ratios are applied:
 *
 *   - read  = 0.1× input    (Sonnet $3 → $0.30, Opus $15 → $1.50, Haiku $1 → $0.10)
 *   - write = 1.25× input   (5m TTL — same ratio across Sonnet/Opus/Haiku)
 *
 * 1h-TTL deployments (write rate 2× input) require an explicit
 * `cacheWritePer1M` override on the pricing entry. This helper is the single
 * place these ratios are encoded; engine cost math
 * (`engine/llm/pricing.ts:computeCost`) and the renderer billing badge
 * (`TokenCostBadge.tsx`) both consume it so the published ratios stay in
 * sync without duplication.
 */
export function anthropicCacheRates(
  pricing: Pick<ModelPricing, "inputPer1M" | "cacheReadPer1M" | "cacheWritePer1M">,
): { read: number; write: number } {
  return {
    read: pricing.cacheReadPer1M ?? pricing.inputPer1M * 0.1,
    write: pricing.cacheWritePer1M ?? pricing.inputPer1M * 1.25,
  };
}

/**
 * Effective context window — picks the beta-tier value when defined.
 *
 * The adapter auto-sends the `context-1m-2025-08-07` header for any Claude
 * model with `contextWindow1MBeta` set, so the larger window is what the
 * model actually delivers. UI denominators and compact thresholds must
 * mirror this resolution to avoid denominator mismatch.
 */
export function effectiveContextWindow(pricing: ModelPricing): number {
  return pricing.contextWindow1MBeta ?? pricing.contextWindow;
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
 * BEFORE calling computeCost.
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
 * Vendor argument selects how `inputTokens` and the cache fields combine —
 * see {@link UsageForCost} for the semantic asymmetry between Anthropic
 * (cache-additive) and OpenAI / Gemini (cache-included).
 *
 * Lives here (not in `engine/llm/pricing.ts`) so renderer-side billing UI
 * (`TokenCostBadge`) consumes the same formula without pulling Node-only
 * imports. The engine module re-exports for back-compat.
 */
export function computeCost(
  usage: UsageForCost,
  pricing: ModelPricing,
  vendor: PricingVendor,
): number {
  // Clamp non-finite + negative inputs to 0 — token usage is monotonic, so a
  // negative value indicates upstream malformed data; letting it through
  // would produce negative USD and pollute the usage dashboard.
  const safe = (n: number | undefined): number =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;

  const input = safe(usage.inputTokens);
  const output = safe(usage.outputTokens);
  const cacheRead = safe(usage.cacheReadTokens);
  const cacheWrite = safe(usage.cacheWriteTokens);

  const per1M = (tokens: number, rate: number): number =>
    (tokens / 1_000_000) * rate;

  switch (vendor) {
    case "claude": {
      // Anthropic raw shape — `input_tokens` 는 fresh-only, cache 가 가산.
      // ratio 정책은 `anthropicCacheRates` 한 곳.
      const { read: cacheReadRate, write: cacheWriteRate } = anthropicCacheRates(pricing);
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
      //
      // Long-context surcharge (gpt-5.4 / gpt-5.4-pro): input>threshold 시
      // 세션 전체가 input × M_in + output × M_out 로 우상향. issue #900.
      const inSurcharge =
        typeof pricing.surchargeInputThreshold === "number"
        && input > pricing.surchargeInputThreshold;
      const inMul = inSurcharge ? (pricing.surchargeInputMultiplier ?? 1) : 1;
      const outMul = inSurcharge ? (pricing.surchargeOutputMultiplier ?? 1) : 1;
      return per1M(input, pricing.inputPer1M * inMul) + per1M(output, pricing.outputPer1M * outMul);
    }
    case "gemini":
    case "vertex-ai": {
      // `promptTokenCount` 가 cachedContentTokenCount 를 이미 포함. cache
      // write 는 storage-per-hour 과금이라 turn-level cost 와 분리되어
      // 이 함수에서 0 으로 둔다 (별도 cron 합산 예정).
      return per1M(input, pricing.inputPer1M) + per1M(output, pricing.outputPer1M);
    }
  }
}
