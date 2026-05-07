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
    "gpt-5.4":                     { inputPer1M: 1.25, outputPer1M: 10, contextWindow: 1_050_000 },
    "gpt-5.4-mini":                { inputPer1M: 1.25, outputPer1M: 10, contextWindow: 1_050_000 },
    "gpt-5.4-nano":                { inputPer1M: 0.5,  outputPer1M: 4,  contextWindow: 1_050_000 },
    "gpt-5.4-pro":                 { inputPer1M: 5,    outputPer1M: 40, contextWindow: 1_050_000 },
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
    "gpt-5.4":                     { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_050_000 },
    "gpt-5.4-mini":                { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_050_000 },
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
  // override (`LVIS_PRICING_OVERRIDE`).
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
 * `FALLBACK_PRICING` on miss.
 *
 * Does NOT consult env overrides. Use `engine/llm/pricing.ts:getModelPricing()`
 * for the override-aware variant.
 */
export function lookupPricing(
  vendor: string,
  model: string,
  table: Record<string, Record<string, ModelPricing>> = DEFAULT_PRICING,
): ModelPricing {
  const vendorTable = table[vendor] ?? {};
  const exact = vendorTable[model];
  if (exact) return exact;
  let bestKey: string | undefined;
  for (const key of Object.keys(vendorTable)) {
    if (model.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  if (bestKey !== undefined) return vendorTable[bestKey];
  return FALLBACK_PRICING;
}

/**
 * Effective context window — picks the beta-tier value when defined.
 *
 * The adapter auto-sends the `context-1m-2025-08-07` header for any Claude
 * model with `contextWindow1MBeta` set, so the larger window is what the
 * model actually delivers. UI denominators and rotation thresholds must
 * mirror this resolution to avoid the 5× denominator mismatch noted in
 * `reference_token_session_4source.md` §4.
 */
export function effectiveContextWindow(pricing: ModelPricing): number {
  return pricing.contextWindow1MBeta ?? pricing.contextWindow;
}
