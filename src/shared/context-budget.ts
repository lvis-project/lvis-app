/**
 * Usable context budget — LVIS model-tier fixed reservations.
 *
 * Browser-safe (no Node imports) so both the renderer hook
 * (`use-context-budget`) and engine paths can derive the same usable
 * denominator.
 *
 * Why fixed buffers not a percentage:
 *   Small models (64K) need proportionally more reservation for output.
 *   With 32K typical max output, 0.85× of 64K (= 54K) leaves only 10K
 *   headroom — single tool-result rounds blow past it. LVIS reserves fixed
 *   output/safety buffers (27K / 30K / 40K) to prevent this asymmetric pinch.
 */

/**
 * Reserve buffer for output + safety, return the *usable* portion of the
 * context window. Caller divides used-tokens by this to get the displayed
 * percentage.
 *
 * - 64,000     → 37,000 (reserved 27K — small models, output-heavy reasoning)
 * - 128,000    → 98,000 (reserved 30K)
 * - 200,000    → 160,000 (reserved 40K — Anthropic default tier)
 * - any other  → max(ctx − 40,000, 0.8 × ctx)
 *               picks the larger of "−40K floor" and "20% reservation",
 *               so 1M ⇒ 960K usable, 32K ⇒ ~25.6K, ≤40K ⇒ 80% (avoids
 *               negative usable on tiny windows).
 */
export function getUsableContext(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  if (contextWindow === 64_000) return contextWindow - 27_000;
  if (contextWindow === 128_000) return contextWindow - 30_000;
  if (contextWindow === 200_000) return contextWindow - 40_000;
  return Math.max(contextWindow - 40_000, Math.floor(contextWindow * 0.8));
}

/**
 * Token preflight trigger threshold — same-session checkpoint compaction.
 *
 * `getUsableContext()` 와 *별도 함수* — 의미가 다름:
 *   - `getUsableContext`  = 분모 (전체 컨텍스트 윈도우의 사용 가능 portion)
 *   - `getPreflightThreshold` = 트리거 (usable 의 80%, LLM compact 진입점)
 *
 * 두 함수가 같은 구조라도 분리해야 향후 임계 비율을 모델 출시/관측치 기반으로
 * 독립 조정 가능.
 *
 * Contract: automatic compact starts at 80% of the model-specific usable
 * context budget. Do not lower this by message count or model tier; the guard
 * also watches provider-reported prompt tokens to catch estimator drift.
 *
 * @returns 절대 token count (Math.floor(usable × pct)). 0 if input invalid.
 */
export function getPreflightThreshold(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const usable = getUsableContext(contextWindow);
  return Math.floor(usable * 0.8);
}
