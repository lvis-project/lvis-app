/**
 * Suggested replies — parser + streaming filter.
 *
 * LLM emits a `<suggested_replies>` block at the end of the final assistant
 * message containing 2~5 follow-up reply candidates. The streaming filter
 * withholds those bytes from the renderer-bound stream so the user never
 * sees the raw tag, then surfaces the parsed list once the stream ends.
 *
 * Parser caps must stay aligned with `SUGGESTED_REPLIES_INSTRUCTION` in
 * `src/prompts/system-prompt-builder.ts`. Instruction recommends 40~60자
 * length with rare 30자 short answers; cap 80 leaves safety margin for
 * brief LLM over-spill. Count cap matches the upper-bound emit guidance
 * (2~5). Drift between layers silently drops emitted candidates.
 */

export const SUGGESTED_REPLIES_OPEN = "<suggested_replies>";
export const SUGGESTED_REPLIES_CLOSE = "</suggested_replies>";

const BLOCK_REGEX = /<suggested_replies>([\s\S]*?)<\/suggested_replies>/;

/** Extract suggested replies from a complete assistant message. */
export function parseSuggestedReplies(raw: string): string[] {
  const match = raw.match(BLOCK_REGEX);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^[\s\-•*]+/, "").trim())
    .filter((line) => line.length > 0 && line.length <= 80)
    .slice(0, 5);
}

/**
 * Strip the suggested-replies block from a complete assistant message.
 *
 * Two passes: closed blocks first, then any stray trailing unclosed block.
 * The unclosed-block fallback guards against vendor-differential malformation
 * (e.g. GPT or Gemini truncating before the closing tag) — otherwise the
 * `<suggested_replies>` open-tag would survive into ~/.lvis/sessions JSONL
 * and re-feed to the LLM as context every turn. The streaming filter
 * already drops the partial block from the user-visible delta stream;
 * this completes the same guarantee at the persistence layer.
 */
export function stripSuggestedReplies(raw: string): string {
  const closed = raw.replace(/\n*<suggested_replies>[\s\S]*?<\/suggested_replies>\s*/g, "");
  const noTrailingOrphan = closed.replace(/\n*<suggested_replies>[\s\S]*$/, "");
  return noTrailingOrphan.trimEnd();
}

export interface StreamingFilter {
  /** Feed a chunk; returns the portion safe to emit to the renderer. */
  feed(chunk: string): string;
  /** Call once the LLM stream is complete. */
  finish(): StreamingFilterResult;
}

export interface StreamingFilterResult {
  /** Tail that was held back but turned out not to be a tag prefix. */
  trailing: string;
  /** Parsed suggestions, empty if no closed block was seen. */
  suggestedReplies: string[];
}

/**
 * Per-LLM-call filter. Chunks arrive in order; the filter emits everything
 * up to (and not including) the opening tag, then withholds the block until
 * the closing tag or stream end. Partial opening-tag suffixes are buffered
 * across chunks so we never emit `<sugg` and then "eat" the rest later.
 */
export function createStreamingFilter(): StreamingFilter {
  let pending = "";
  let inBlock = false;
  let blockBuffer = "";

  return {
    feed(chunk: string): string {
      if (inBlock) {
        blockBuffer += chunk;
        return "";
      }
      pending += chunk;
      const openIdx = pending.indexOf(SUGGESTED_REPLIES_OPEN);
      if (openIdx >= 0) {
        const visible = pending.slice(0, openIdx).replace(/\n*$/, "");
        blockBuffer = pending.slice(openIdx);
        pending = "";
        inBlock = true;
        return visible;
      }
      const heldBack = longestSuffixPrefix(pending, SUGGESTED_REPLIES_OPEN);
      if (heldBack > 0) {
        const visible = pending.slice(0, pending.length - heldBack);
        pending = pending.slice(pending.length - heldBack);
        return visible;
      }
      const visible = pending;
      pending = "";
      return visible;
    },
    finish(): StreamingFilterResult {
      if (inBlock) {
        return { trailing: "", suggestedReplies: parseSuggestedReplies(blockBuffer) };
      }
      return { trailing: pending, suggestedReplies: [] };
    },
  };
}

function longestSuffixPrefix(text: string, pattern: string): number {
  const max = Math.min(text.length, pattern.length - 1);
  for (let i = max; i > 0; i--) {
    if (pattern.startsWith(text.slice(text.length - i))) return i;
  }
  return 0;
}
