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




export function countHangul(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xac00 && c <= 0xd7a3) count++;
  }
  return count;
}




export function estimateTokens(text: string): number {
  if (text.length === 0) return 1;
  const hangul = countHangul(text);
  const ratio = hangul / text.length;
  const weight = ratio >= 0.5 ? 1.3 : 1.0;
  return Math.ceil((text.length * weight) / 4) + 1;
}
