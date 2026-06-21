/**
 * Token Estimation — shared primitive
 *
 * Pure, dependency-free token-count heuristics. Lives in shared/ alongside
 * pricing-data, context-budget, and tool-result-stub so any layer can size a
 * string without an upward dependency on engine/. Architecture §4.6.2: the
 * prompts/ layer must not depend on engine/, and engine/ is the downward
 * assembler — estimateTokens is a leaf primitive that belongs below both.
 *
 * `engine/auto-compact.ts` re-exports these for existing engine callers, so
 * moving the source here is import-transparent to the rest of the engine.
 */

/**
 * 한글 음절 (가-힣 범위, U+AC00 ~ U+D7A3) 카운트 — Korean weighting helper.
 * Anthropic/OpenAI/Gemini 토크나이저 모두 한글을 1.5~2x 비율로 토큰화하므로
 * chars/4 공식이 한글 위주 대화에서는 underestimate. 50% 이상이면 1.3x 보정.
 */
export function countHangul(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xac00 && c <= 0xd7a3) count++;
  }
  return count;
}

/**
 * 텍스트의 토큰 수 추정 (simple length/4 + 1 heuristic) + 한글 가중치.
 *
 * 한글 비율 ≥ 50% 면 weight 1.3 적용 (mixed-language 코드+주석 등은 ratio < 50% → weight 1.0).
 * 보수적 fallback: 모르는 문자는 기본 4-char/token 가정.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 1;
  const hangul = countHangul(text);
  const ratio = hangul / text.length;
  const weight = ratio >= 0.5 ? 1.3 : 1.0;
  return Math.ceil((text.length * weight) / 4) + 1;
}
