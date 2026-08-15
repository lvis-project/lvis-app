import { sanitizeUntrustedReviewerText } from "./reviewer/rationale-scope-reviewer.js";

/**
 * The optional parent-conversation block of the tier-2 evidence.
 *
 * Tier 2 asks a model to judge a call against the task the parent gave its
 * child. The task alone is often enough; when it is not, what is missing is
 * usually the conversation the task came out of. This composes that
 * conversation — and composing it is the whole security surface, because it is
 * the one part of the evidence whose raw material is not host-authored.
 *
 * Three rules make it safe to send, and all three live here rather than at the
 * call site:
 *
 *   1. **No child-authored text.** A sub-agent's report lands in its parent's
 *      transcript as a user message carrying `meta.subAgentReport`. A child
 *      that could get its own prose into this block would be arguing for its
 *      own approval through its parent's mouth, which is exactly the attack the
 *      rest of the evidence shape was built to prevent. Every host-injected
 *      user message is dropped, not merely the ones labelled as reports.
 *   2. **Text only.** Assistant `content` is read; `thought`, `toolCalls` and
 *      every `tool_result` record are not. Tool bodies are where credentials,
 *      file contents and command output live, and none of it helps answer
 *      "does this call serve the task".
 *   3. **Bounded before masked.** Each turn is cut to its per-turn bound before
 *      the DLP pass runs, for the reason the gate bounds arguments before
 *      masking them: masking walks the text, and a megabyte-long turn costs
 *      minutes on this process's only thread. A bound applied to the OUTPUT
 *      would have paid that cost already.
 */
export interface ParentContextTurn {
  /** Who spoke. Never a sub-agent — see rule 1. */
  speaker: "user" | "assistant";
  /** Host-bounded, DLP-masked, markup-stripped text of that turn. */
  text: string;
}

/** Longest one quoted turn may be. Applied BEFORE masking. */
const MAX_TURN_CHARS = 500;
/** Longest the whole block may be, summed over its turns. */
const MAX_TOTAL_CHARS = 2_000;

/**
 * Meta keys that mark a user-role record as something other than the user
 * typing. `subAgentReport` is the child-authored one and the reason this list
 * exists; the others are host or import machinery whose text is no more the
 * parent's own words than a child's report is.
 */
const NON_USER_AUTHORED_META_KEYS = [
  "subAgentReport",
  "hostInjectionId",
  "compactBoundary",
  "systemNotice",
  "importedTrigger",
] as const;

function metaOf(record: Record<string, unknown>): Record<string, unknown> | null {
  const meta = record.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  return meta as Record<string, unknown>;
}

/**
 * The text of one transcript record, or `null` when the record is not a turn
 * this block may quote.
 *
 * Structural rather than typed on purpose: the input is JSONL a previous
 * version of this app wrote, so an unrecognised shape is a shape whose
 * authorship this function cannot establish — and it drops it.
 */
function quotableTurn(record: unknown): ParentContextTurn | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const message = record as Record<string, unknown>;
  const meta = metaOf(message);

  if (message.role === "user") {
    if (
      meta !== null &&
      NON_USER_AUTHORED_META_KEYS.some((key) => meta[key] !== undefined)
    ) {
      return null;
    }
    // `displayText` is what the user saw themselves type; `content` can carry
    // routing and provenance wrappers around it. Array content is attachments
    // and content parts — not text, so not quoted.
    const displayText = meta?.displayText;
    const raw =
      typeof displayText === "string"
        ? displayText
        : typeof message.content === "string"
          ? message.content
          : null;
    return raw === null ? null : { speaker: "user", text: raw };
  }

  if (message.role === "assistant") {
    // Deliberately only `content`: `thought`/`thinkingBlocks` are reasoning the
    // user never saw, and `toolCalls` are the tool bodies rule 2 excludes.
    return typeof message.content === "string"
      ? { speaker: "assistant", text: message.content }
      : null;
  }

  return null;
}

/**
 * Compose the parent-context block from a parent session's transcript.
 *
 * `maxTurns` is the caller's already-clamped policy value; `0` (the default
 * policy) returns an empty array without reading anything, so the feature
 * being off costs nothing and shows nothing.
 *
 * Turns are collected newest-first — the recent ones are the ones that explain
 * the call being judged — and returned oldest-first so the block reads as a
 * conversation.
 */
export function summarizeParentContextTurns(
  transcript: readonly unknown[],
  maxTurns: number,
): ParentContextTurn[] {
  if (!Number.isFinite(maxTurns) || maxTurns <= 0) return [];
  const collected: ParentContextTurn[] = [];
  let totalChars = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (collected.length >= maxTurns) break;
    const turn = quotableTurn(transcript[i]);
    if (turn === null) continue;
    // Bound, then mask — never the other way round (rule 3).
    const bounded = turn.text.slice(0, MAX_TURN_CHARS);
    if (totalChars + bounded.length > MAX_TOTAL_CHARS) break;
    const text = sanitizeUntrustedReviewerText(bounded, MAX_TURN_CHARS);
    if (!text) continue;
    totalChars += bounded.length;
    collected.push({ speaker: turn.speaker, text });
  }
  return collected.reverse();
}
