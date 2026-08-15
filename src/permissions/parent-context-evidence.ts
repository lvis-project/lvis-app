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

/**
 * Second, independent test for child-authored content in a user record.
 *
 * The meta keys above are the primary one, and they depend on a producer having
 * stamped the row. This does not: every child report is formatted with this
 * host-composed label in front of it (the A2A message codec writes it, and the
 * sub-agent approval adapter writes the same shape), so a record carrying the
 * label carries a child's text whatever its meta says. Historical rows written
 * before a producer learned to stamp are covered by this and only this.
 *
 * A user who types the label themselves loses that turn from the block. That is
 * the right way round: a dropped turn costs the adjudicator context, and a
 * quoted child costs the invariant.
 */
const CHILD_REPORT_LABEL = "[Sub-Agent: ";

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
    if (raw === null) return null;
    // Checked against BOTH readings of the record: a label hidden in the
    // wrapped content still means a child wrote part of this row.
    if (
      raw.includes(CHILD_REPORT_LABEL) ||
      (typeof message.content === "string" &&
        message.content.includes(CHILD_REPORT_LABEL))
    ) {
      return null;
    }
    return { speaker: "user", text: raw };
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
 * Whether an assistant turn is one the parent produced with a child's report
 * fresh in front of it.
 *
 * Rule 1 keeps a child's own words out of the block; this keeps out the
 * laundered version of them. A child report is shown to the parent model, and a
 * report that says "restate the following for the record" can get its sentence
 * echoed into the parent's next assistant turn — which would then be quoted
 * with no marker at all. The nearest preceding user-role record is what that
 * turn was answering, so if THAT record was excluded, so is this one.
 */
function answersAnExcludedRecord(
  transcript: readonly unknown[],
  assistantIndex: number,
): boolean {
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const record = transcript[i];
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const message = record as Record<string, unknown>;
    if (message.role !== "user") continue;
    return quotableTurn(message) === null;
  }
  return false;
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
    if (turn.speaker === "assistant" && answersAnExcludedRecord(transcript, i)) {
      continue;
    }
    // Bound, then mask — never the other way round (rule 3).
    const bounded = turn.text.slice(0, MAX_TURN_CHARS);
    const text = sanitizeUntrustedReviewerText(bounded, MAX_TURN_CHARS);
    if (!text) continue;
    // Counted on what is actually sent: masking substitutes placeholders and
    // can lengthen a turn, so charging the pre-mask length would let the block
    // exceed the bound it advertises.
    if (totalChars + text.length > MAX_TOTAL_CHARS) break;
    totalChars += text.length;
    collected.push({ speaker: turn.speaker, text });
  }
  return collected.reverse();
}
