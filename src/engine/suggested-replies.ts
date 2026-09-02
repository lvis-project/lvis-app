




export const SUGGESTED_REPLIES_OPEN = "<suggested_replies>";
export const SUGGESTED_REPLIES_CLOSE = "</suggested_replies>";

/**
 * Tag matching is whitespace-tolerant on purpose.
 *
 * Models drift on the exact spelling — `< suggested_replies>` with a space
 * after the bracket is the observed one. Matching the literal only meant the
 * open tag was never found, so the filter passed the whole block through and
 * the user saw the raw markup, closing tag and all, instead of reply chips.
 * A one-character deviation should degrade the suggestions, not the transcript.
 *
 * The three consumers (parse, strip, stream) share these definitions so a
 * spelling one accepts can never be a spelling another leaks.
 */
const OPEN_TAG = String.raw`<\s*suggested_replies\s*>`;
const CLOSE_TAG = String.raw`<\s*\/\s*suggested_replies\s*>`;

const BLOCK_REGEX = new RegExp(`${OPEN_TAG}([\\s\\S]*?)${CLOSE_TAG}`);
const CLOSED_BLOCK_GLOBAL = new RegExp(`\\n*${OPEN_TAG}[\\s\\S]*?${CLOSE_TAG}\\s*`, "g");
const TRAILING_ORPHAN = new RegExp(`\\n*${OPEN_TAG}[\\s\\S]*$`);
const OPEN_TAG_ANYWHERE = new RegExp(OPEN_TAG);

/**
 * Longest tail of `text` that could still turn into an opening tag.
 *
 * The literal version asked "how much of this suffix is a prefix of the exact
 * tag". With a tolerant tag there is no single string to prefix-match, so the
 * question becomes whether the suffix could still *grow into* one: it must
 * start with `<`, and its non-whitespace characters must so far spell the tag.
 * Bounded so a stray `<` followed by a wall of whitespace cannot make the
 * filter buffer without limit.
 */
const MAX_PARTIAL_OPEN_TAG = 64;

function couldGrowIntoOpenTag(candidate: string): boolean {
  if (!candidate.startsWith("<")) return false;
  const compact = candidate.replace(/\s+/g, "");
  return SUGGESTED_REPLIES_OPEN.startsWith(compact);
}

function partialOpenTagLength(text: string): number {
  const max = Math.min(text.length, MAX_PARTIAL_OPEN_TAG);
  for (let i = max; i > 0; i--) {
    if (couldGrowIntoOpenTag(text.slice(text.length - i))) return i;
  }
  return 0;
}

/**
 * Extract the suggested reply from a complete assistant message.
 *
 * The prompt asks for exactly one candidate; the first well-formed line wins
 * so a model that still lists alternatives degrades to its top pick instead of
 * to nothing.
 */
export function parseSuggestedReply(raw: string): string | null {
  const match = raw.match(BLOCK_REGEX);
  if (!match) return null;
  const first = match[1]
    .split("\n")
    .map((line) => line.replace(/^[\s\-•*]+/, "").trim())
    .find((line) => line.length > 0 && line.length <= 80);
  return first ?? null;
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
  const closed = raw.replace(CLOSED_BLOCK_GLOBAL, "");
  const noTrailingOrphan = closed.replace(TRAILING_ORPHAN, "");
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
  /** Parsed suggestion, null if no closed block was seen. */
  suggestedReply: string | null;
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
      const openMatch = OPEN_TAG_ANYWHERE.exec(pending);
      const openIdx = openMatch ? openMatch.index : -1;
      if (openIdx >= 0) {
        const visible = pending.slice(0, openIdx).replace(/\n*$/, "");
        blockBuffer = pending.slice(openIdx);
        pending = "";
        inBlock = true;
        return visible;
      }
      const heldBack = partialOpenTagLength(pending);
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
        return { trailing: "", suggestedReply: parseSuggestedReply(blockBuffer) };
      }
      return { trailing: pending, suggestedReply: null };
    },
  };
}
