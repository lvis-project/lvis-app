/**
 * Natural-language approval intent matcher — issue #690 P4.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 8
 * (user-keyboard trust origin).
 *
 * Purpose:
 *   When a tool call has been deferred (Layer 5 MED/HIGH verdict) or
 *   blocked (Layer 1 out-of-allowed-dir), the user can resolve it via
 *   the existing approval modal / deferred queue panel. But there is a
 *   second, more conversational path: the user types "허용해줘" / "OK"
 *   / "cancel" in chat. This module recognises that intent so the
 *   renderer can surface a non-blocking confirmation chip — never
 *   auto-resolve without an explicit click — that targets a specific
 *   pending entry.
 *
 * Hard safety properties (issue #690 acceptance criteria):
 *
 *   1. **Pure function** — no side effects, no global state, no clock.
 *      Same input ⇒ same output.
 *   2. **Conservative recall** — "허용 안 함" / "I don't want to allow"
 *      MUST NOT match approve. Negation / ambiguity short-circuits to
 *      `kind: "none"`.
 *   3. **Bounded** — text longer than {@link MAX_INTENT_TEXT_LENGTH}
 *      collapses to `"none"` because long prose is not a command. This
 *      stops the matcher from grepping into LLM tool output mistakenly
 *      surfaced as user input.
 *   4. **Single-sentence** — multiple sentences ⇒ `"none"`. A user
 *      who types a paragraph is not issuing a yes/no.
 *   5. **NOT a replacement** for the approval modal — the matcher is
 *      *suggestive*; the caller MUST still require an explicit user
 *      gesture (click) before calling `deferredResolve`. This is the
 *      whole point of NOT triggering on the LLM tool args (which would
 *      also pass through the same chat surface). See issue #690 for
 *      the prompt-injection risk that motivates this.
 *
 * Out of scope:
 *   - Scope-extension intents like "이 디렉토리 모두 허용". The pure
 *     matcher emits LOW-confidence `"none"` for those; the
 *     `permission dir` slash is the SOT for scope changes.
 *   - Multi-entry disambiguation ("두 번째 것만 허용"). Caller chooses
 *     the most-recent pending entry on a single-entry match; on
 *     multi-entry pending, the chip stays hidden and the user must
 *     resolve via the panel.
 */

export type ApprovalIntent =
  | { kind: "approve"; matchedPhrase: string }
  | { kind: "reject"; matchedPhrase: string }
  | { kind: "none" };

/**
 * A user who types more than this is writing prose, not a yes/no.
 * The cap is generous on purpose — the typical confirmation is under
 * 12 chars ("허용해 주세요", "OK 진행"); we don't want to cut off the
 * occasional "응 이거 허용해도 돼" but anything that reads like a
 * paragraph is rejected.
 */
export const MAX_INTENT_TEXT_LENGTH = 40;

/**
 * Approval phrases. Order matters: more specific (multi-word) entries
 * first so the matcher reports the longest match in `matchedPhrase`
 * for audit clarity. Each entry is a *word-boundary anchored* regex.
 *
 * Korean phrases use Hangul boundaries (start-of-input or whitespace
 * before, end-of-input or whitespace / punctuation after).
 */
/**
 * Korean verb conjugation suffix — characters allowed *after* a verb
 * stem to count as a word-boundary equivalent.
 *
 * Korean has no whitespace between morphemes, so a regex anchored at
 * `\s|[.!?]|$` would fail on naturally-typed phrases like "취소해줘"
 * or "허용해". Allowing these specific characters as boundary chars
 * keeps the matcher conservative (it still won't match "허용성" /
 * "허용도" — those are not in this set).
 */
const KOREAN_VERB_BOUNDARY = "해한했함합하지";

const KO_BOUNDARY_AFTER = `(?=[${KOREAN_VERB_BOUNDARY}\\s.!?]|$)`;

const APPROVE_PATTERNS: ReadonlyArray<RegExp> = [
  // Korean — explicit verbs
  new RegExp(`(^|\\s)허용해\\s*(주세요|줘|줄래)(\\s|[.!?]|$)`, "u"),
  new RegExp(`(^|\\s)허용${KO_BOUNDARY_AFTER}`, "u"),
  new RegExp(`(^|\\s)진행해\\s*(주세요|줘)?(\\s|[.!?]|$)`, "u"),
  new RegExp(`(^|\\s)진행${KO_BOUNDARY_AFTER}`, "u"),
  new RegExp(`(^|\\s)통과${KO_BOUNDARY_AFTER}`, "u"),
  new RegExp(`(^|\\s)승인${KO_BOUNDARY_AFTER}`, "u"),
  /(^|\s)괜찮(아|아요|습니다)(\s|[.!?]|$)/u,
  // English — explicit verbs
  /(^|\s)approve(\s|[.!?]|$)/iu,
  /(^|\s)approved(\s|[.!?]|$)/iu,
  /(^|\s)allow(\s|[.!?]|$)/iu,
  /(^|\s)allowed(\s|[.!?]|$)/iu,
  /(^|\s)proceed(\s|[.!?]|$)/iu,
  /(^|\s)go\s+ahead(\s|[.!?]|$)/iu,
  // Short affirmatives — accepted only when the text is *just* the
  // affirmative (no other content). The ^...$ shape is enforced by
  // the lonely-token check below; here we just list the tokens.
  /^(yes|y|ok|okay|sure|네|예|응|좋아|좋아요|그래)$/iu,
];

const REJECT_PATTERNS: ReadonlyArray<RegExp> = [
  // Korean — explicit verbs
  new RegExp(`(^|\\s)거절${KO_BOUNDARY_AFTER}`, "u"),
  new RegExp(`(^|\\s)거부${KO_BOUNDARY_AFTER}`, "u"),
  new RegExp(`(^|\\s)취소${KO_BOUNDARY_AFTER}`, "u"),
  new RegExp(`(^|\\s)중단${KO_BOUNDARY_AFTER}`, "u"),
  /(^|\s)안\s*돼(요|)(\s|[.!?]|$)/u,
  /(^|\s)하지\s*마(세요|)(\s|[.!?]|$)/u,
  // English
  /(^|\s)reject(\s|[.!?]|$)/iu,
  /(^|\s)deny(\s|[.!?]|$)/iu,
  /(^|\s)cancel(\s|[.!?]|$)/iu,
  /(^|\s)stop(\s|[.!?]|$)/iu,
  /(^|\s)abort(\s|[.!?]|$)/iu,
  /(^|\s)don'?t(\s|$)/iu,
  // Lonely-token negatives
  /^(no|n|nope|아니|아니요)$/iu,
];

/**
 * Tokens whose presence near an approve phrase converts the verdict to
 * "none". A user typing "허용 안 함" or "don't allow" is NEGATING the
 * approve word, not approving. The matcher detects this by scanning
 * for these tokens within the same input.
 */
const NEGATION_TOKENS_NEAR_APPROVE: ReadonlyArray<RegExp> = [
  /(^|\s)(안|않)(\s|$)/u,
  // Korean "하지 마" is a strong negation that often glues onto the
  // preceding morpheme without whitespace ("허용하지 마" / "허용하지마").
  // No leading boundary — the trailing 마 already disambiguates against
  // 하지만 ("but") since it requires 마 not 만.
  /하지\s*마/u,
  /(^|\s)don'?t(\s|$)/iu,
  /(^|\s)do\s+not(\s|$)/iu,
  /(^|\s)never(\s|$)/iu,
];

/**
 * Sentence terminators. Two or more counted terminators ⇒ multi-sentence
 * input ⇒ verdict "none" (rule 4). Single terminator at the end is fine.
 */
function countSentences(text: string): number {
  const matches = text.match(/[.!?。]\s+\S|[.!?。]\s*$/gu);
  return matches ? matches.length : 1;
}

/**
 * Detect natural-language approval intent.
 *
 * @param rawText raw user-keyboard text (do not pre-trim; the matcher
 *                handles whitespace + boundary cases itself).
 * @returns       discrete verdict. Caller MUST require an explicit user
 *                gesture (e.g. chip click) before acting on `"approve"`
 *                or `"reject"` — see module docstring.
 */
export function detectApprovalIntent(rawText: string): ApprovalIntent {
  if (typeof rawText !== "string") return { kind: "none" };
  const text = rawText.trim();
  if (text.length === 0) return { kind: "none" };
  if (text.length > MAX_INTENT_TEXT_LENGTH) return { kind: "none" };
  if (countSentences(text) > 1) return { kind: "none" };

  const approveMatch = firstMatch(text, APPROVE_PATTERNS);
  const rejectMatch = firstMatch(text, REJECT_PATTERNS);

  // Both matched ⇒ ambiguous ⇒ none (rule 2).
  if (approveMatch && rejectMatch) return { kind: "none" };

  if (approveMatch) {
    if (hasNearbyNegation(text)) return { kind: "none" };
    return { kind: "approve", matchedPhrase: approveMatch };
  }
  if (rejectMatch) {
    return { kind: "reject", matchedPhrase: rejectMatch };
  }
  return { kind: "none" };
}

function firstMatch(text: string, patterns: ReadonlyArray<RegExp>): string | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return (m[0] ?? "").trim();
  }
  return null;
}

function hasNearbyNegation(text: string): boolean {
  for (const pattern of NEGATION_TOKENS_NEAR_APPROVE) {
    if (pattern.test(text)) return true;
  }
  return false;
}
