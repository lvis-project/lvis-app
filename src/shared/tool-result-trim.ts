/**
 * Tool-result generic size cap (Issue #902) — measurement only.
 *
 * Returns `truncated` info when a single tool_result content exceeds the
 * cap; otherwise returns the input unchanged. Used by
 * `ConversationHistory.append`/`.restore` to *mark* over-cap tool_result
 * messages with `meta.truncated`; the actual content swap to a short
 * stub form happens in `wire-serialize.stubMarkedToolResults` so that
 * in-memory content stays raw verbatim for UI / inspection while the
 * wire payload and on-disk jsonl both receive the stub (mirroring the
 * existing `meta.compactedAt` lifecycle exactly).
 *
 * Background: the user-visible repro (Issue #900) was a single
 * `index_documents` response at 438KB (~110K tokens) + an `index_scan`
 * at 75KB which together pushed the next-turn input to 271K — over the
 * 200K TPM ceiling of gpt-5.4-nano. The plugin-side fix is tracked in
 * `lvis-plugin-local-indexer#131` (per-result pagination), but the host
 * must defend itself too: any future plugin or builtin can hit the same
 * trap, and the user's whole conversation should not be broken by one
 * misbehaving tool.
 */

import { estimateTokens } from "../engine/auto-compact.js";

/**
 * Single tool_result above this line count is capped. 100 lines comfortably
 * passes normal `ls -la`, `git status`, `git log -50` while catching the
 * thousands-of-lines payloads (`index_documents` returning a full corpus).
 */
export const MAX_TOOL_RESULT_LINES = 100;

/**
 * Single tool_result above this token count is capped. 2K tokens is roughly
 * 8KB of English / 5KB of Korean — enough head for the model to reason
 * about the result, but well below the 6K-token per-result smell threshold
 * for small-tier models (nano = 200K TPM Tier 1).
 */
export const MAX_TOOL_RESULT_TOKENS = 2_000;

/**
 * Hard byte ceiling — content above this size short-circuits the exact
 * line/token scan and is treated as oversized verbatim. Defends against
 * an adversarial plugin returning a 100MB+ payload that would otherwise
 * cost O(N) scans inside the host's event loop. Set well above any
 * realistic legitimate tool output (50MB ≈ a full PDF text dump).
 */
export const HARD_BYTES_CEILING = 50_000_000;

/**
 * Result of a trim measurement — `truncated` is undefined when the input
 * is within the cap (caller skips meta marking).
 */
export interface TrimmedToolResult {
  truncated?: {
    originalLines: number;
    originalTokens: number;
    originalBytes: number;
    trimmedAt: string;
  };
}

/**
 * Measure a single tool_result content string against the cap. Pure: depends
 * only on inputs, no IO. Returns `{ truncated: undefined }` when the cap
 * is not exceeded (caller can short-circuit meta marking + allocation).
 */
export function trimOversizedToolResult(content: string): TrimmedToolResult {
  // Hard ceiling — skip exact scan for adversarial-sized payloads. We
  // still need *some* count to fill the marker, so use a sentinel:
  // `originalLines = -1` signals "scan skipped due to hard ceiling".
  if (content.length > HARD_BYTES_CEILING) {
    return {
      truncated: {
        originalLines: -1,
        originalTokens: -1,
        originalBytes: content.length,
        trimmedAt: new Date().toISOString(),
      },
    };
  }
  const originalLines = countLines(content);
  if (originalLines <= MAX_TOOL_RESULT_LINES) {
    const originalTokens = estimateTokens(content);
    if (originalTokens <= MAX_TOOL_RESULT_TOKENS) {
      return {};
    }
    return {
      truncated: {
        originalLines,
        originalTokens,
        originalBytes: content.length,
        trimmedAt: new Date().toISOString(),
      },
    };
  }
  return {
    truncated: {
      originalLines,
      originalTokens: estimateTokens(content),
      originalBytes: content.length,
      trimmedAt: new Date().toISOString(),
    },
  };
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}
