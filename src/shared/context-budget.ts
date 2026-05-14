/**
 * Usable context budget — Cline-style model-tier fixed buffers.
 *
 * Browser-safe (no Node imports) so both the renderer hook
 * (`use-context-budget`) and engine paths can derive the same usable
 * denominator.
 *
 * Why fixed buffers not a percentage:
 *   Small models (64K) need proportionally more reservation for output.
 *   With 32K typical max output, 0.85× of 64K (= 54K) leaves only 10K
 *   headroom — single tool-result rounds blow past it. Cline's empirical
 *   buffers (27K / 30K / 40K) prevent this asymmetric pinch.
 *
 * Source: github.com/cline/cline `src/core/context/context-management/
 *         context-window-utils.ts` (Lvis ref `reference_token_session_4source.md` §2)
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
 * Layer 0 pre-flight 트리거 임계 — `infinity-session-redesign-v3.md` §6.
 *
 * `getUsableContext()` 와 *별도 함수* — 의미가 다름:
 *   - `getUsableContext`  = 분모 (전체 컨텍스트 윈도우의 사용 가능 portion)
 *   - `getPreflightThreshold` = 트리거 (usable 의 conservative %, Layer 2 압축 진입점)
 *
 * 두 함수가 같은 구조라도 분리해야 향후 임계 비율을 모델 출시/관측치 기반으로
 * 독립 조정 가능.
 *
 * 2026-05 조정: estimateMessagesTokens 가 영어/코드 위주 대화에서 실제 토큰 수를
 * ~15-25% underestimate (chars/4 vs 실제 3-3.5 chars/token) 하는 것을 보완하여
 * threshold 를 낮춤. runPreflightGuard 가 실제 tokensIn 도 이중 감시하므로 더
 * 이른 compact 진입을 보장. 업데이트된 default:
 *
 *   - 64K  context  → 45 %  of usable  (≈ 16K)   small models / 단일 라운드 비중 큼
 *   - 128K context  → 50 %  of usable  (≈ 49K)
 *   - 200K context  → 55 %  of usable  (≈ 88K)   Anthropic default tier
 *   - 1M   context  → 60 %  of usable  (≈ 576K)
 *   - other         → 55 %  of usable
 *
 * 근거: Gemini CLI 의 50% 추세 (PR #13517) + estimator undercount 실측 보정.
 *
 * @returns 절대 token count (Math.floor(usable × pct)). 0 if input invalid.
 */
export function getPreflightThreshold(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const usable = getUsableContext(contextWindow);
  let pct: number;
  if (contextWindow <= 64_000) pct = 0.45;
  else if (contextWindow <= 128_000) pct = 0.50;
  else if (contextWindow <= 200_000) pct = 0.55;
  else if (contextWindow <= 1_000_000) pct = 0.60;
  else pct = 0.55;
  return Math.floor(usable * pct);
}
