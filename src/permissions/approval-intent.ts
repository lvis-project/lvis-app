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
 * The cap is intentionally tight — the typical confirmation is under
 * 12 chars ("허용해 주세요", "OK 진행"); anything that reads like a
 * paragraph is rejected. Round-1 security review tightened from 40 to
 * 24 to shrink the false-positive surface for LLM tool-output text that
 * happens to start with an approve phrase.
 */
export const MAX_INTENT_TEXT_LENGTH = 24;

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
  // Round-1 security review: dropped single-letter "y" — typo risk too
  // high (a user mid-typing "next question" would fire approve).
  /^(yes|ok|okay|sure|네|예|응|좋아|좋아요|그래)$/iu,
];

const REJECT_PATTERNS: ReadonlyArray<RegExp> = [
  // Korean — explicit verbs
  new RegExp(`(^|\\s)거절${KO_BOUNDARY_AFTER}`, "u"),
  new RegExp(`(^|\\s)거부${KO_BOUNDARY_AFTER}`, "u"),
  new RegExp(`(^|\\s)취소${KO_BOUNDARY_AFTER}`, "u"),
  new RegExp(`(^|\\s)중단${KO_BOUNDARY_AFTER}`, "u"),
  /(^|\s)안\s*돼(요|)(\s|[.!?]|$)/u,
  /(^|\s)하지\s*마(세요|)(\s|[.!?]|$)/u,
  // English — `don['’]?t` accepts straight + smart apostrophe (paste from macOS).
  /(^|\s)reject(\s|[.!?]|$)/iu,
  /(^|\s)deny(\s|[.!?]|$)/iu,
  /(^|\s)cancel(\s|[.!?]|$)/iu,
  /(^|\s)stop(\s|[.!?]|$)/iu,
  /(^|\s)abort(\s|[.!?]|$)/iu,
  /(^|\s)don['’]?t(\s|$)/iu,
  // Lonely-token negatives — single-letter "n" removed (round-1 review).
  /^(no|nope|아니|아니요)$/iu,
];

/**
 * Tokens whose presence near an approve phrase converts the verdict to
 * "none". A user typing "허용 안 함" / "허용 안해" / "허용안돼" or
 * "don't allow" is NEGATING the approve word, not approving.
 *
 * Round-1 fixes:
 *   - Drop space boundary on 안/않 — natural Korean often glues these
 *     onto the preceding morpheme ("허용안함", "안허용"). Substring
 *     match within the 24-char single-sentence input is the safety
 *     envelope; the broader anchor would otherwise miss real negations.
 *   - Add 못 (Korean impossibility marker — "허용 못 함").
 *   - Add smart apostrophe variant for English contractions.
 */
const NEGATION_TOKENS_NEAR_APPROVE: ReadonlyArray<RegExp> = [
  /(안|않|못)/u,
  /하지\s*마/u,
  /(^|\s)don['’]?t(\s|$)/iu,
  /(^|\s)do\s+not(\s|$)/iu,
  /(^|\s)never(\s|$)/iu,
  /(^|\s)can['’]?t(\s|$)/iu,
  /(^|\s)cannot(\s|$)/iu,
];

/**
 * Reject-verb stems that can carry a "don't <verb>" semantic when
 * suffixed with negation. Used by {@link hasNegationAfterRejectVerb}
 * to distinguish "취소하지 마" (negate "취소") from "하지 마" alone
 * (which IS the reject phrase, not a negation of one).
 *
 * Round-1 critic CRITICAL — symmetric negation for reject path.
 */
const REJECT_VERB_STEMS: ReadonlyArray<string> = [
  "거절",
  "거부",
  "취소",
  "중단",
  "reject",
  "deny",
  "cancel",
  "stop",
  "abort",
];

/**
 * Korean / English suffixes that negate a preceding reject verb
 * (i.e. convert "거절하지 마" → "don't reject").
 */
const NEGATION_SUFFIXES_AFTER_REJECT: ReadonlyArray<RegExp> = [
  /하지\s*마/u,
  /(\s|^)(안|않)/u,
  /(\s|^)(don['’]?t|do\s+not|never|can['’]?t|cannot)/iu,
];

/**
 * Sentence-terminator count. Round-1 fix: previous implementation
 * required whitespace + token *after* the terminator, so "진짜? 허용해"
 * (no trailing punctuation) counted as 1. We now count terminators
 * directly — any text with ≥ 2 terminators OR ≥ 1 terminator followed
 * by non-trivial content is treated as multi-sentence.
 */
function countSentences(text: string): number {
  const terminators = (text.match(/[.!?。]/gu) ?? []).length;
  if (terminators >= 2) return terminators;
  if (terminators === 1) {
    // Single terminator: multi-sentence iff there's substantive content
    // BOTH before AND after the terminator.
    const idx = text.search(/[.!?。]/u);
    const before = text.slice(0, idx).trim();
    const after = text.slice(idx + 1).trim();
    if (before.length > 0 && after.length > 0) return 2;
  }
  return 1;
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
  // Normalize composed/decomposed Hangul + Latin so paste-from-Finder
  // (NFD) and typed text (NFC) produce identical match results.
  // Round-1 code-reviewer finding (unicode normalization).
  const text = rawText.normalize("NFC").trim();
  if (text.length === 0) return { kind: "none" };
  if (text.length > MAX_INTENT_TEXT_LENGTH) return { kind: "none" };
  if (countSentences(text) > 1) return { kind: "none" };
  // Round-1 test-engineer CRITICAL — question forms ("허용했나요?",
  // "허용 됩니까?") contain approve tokens but are not directives.
  // The presence of any question mark (ASCII or full-width) forces
  // "none" — a user issuing a directive does not append "?".
  if (/[?？]/u.test(text)) return { kind: "none" };

  const approveMatch = firstMatch(text, APPROVE_PATTERNS);
  const rejectMatch = firstMatch(text, REJECT_PATTERNS);

  // Both matched ⇒ ambiguous ⇒ none (rule 2).
  if (approveMatch && rejectMatch) return { kind: "none" };

  if (approveMatch) {
    if (hasNearbyNegation(text, NEGATION_TOKENS_NEAR_APPROVE)) {
      return { kind: "none" };
    }
    return { kind: "approve", matchedPhrase: approveMatch };
  }
  if (rejectMatch) {
    // Round-1 critic CRITICAL: symmetric negation for reject path.
    // Only treat as none when the negation appears *after* a reject
    // VERB STEM ("취소", "cancel", ...). Standalone "하지 마" / "안
    // 돼" IS a reject phrase and must remain reject.
    if (hasNegationAfterRejectVerb(text)) {
      return { kind: "none" };
    }
    return { kind: "reject", matchedPhrase: rejectMatch };
  }
  return { kind: "none" };
}

function hasNegationAfterRejectVerb(text: string): boolean {
  const lower = text.toLowerCase();
  for (const stem of REJECT_VERB_STEMS) {
    const idx = lower.indexOf(stem);
    if (idx < 0) continue;
    // Suffix negation (Korean "취소하지 마"): pattern follows the verb.
    const tail = text.slice(idx + stem.length);
    for (const suffix of NEGATION_SUFFIXES_AFTER_REJECT) {
      if (suffix.test(tail)) return true;
    }
    // Prefix negation (English "don't cancel" / "never reject"): pattern
    // precedes the verb. The window is the slice BEFORE the verb match;
    // any English negation token there flips the verdict.
    const head = text.slice(0, idx);
    if (/(^|\s)(don['’]?t|do\s+not|never|can['’]?t|cannot)(\s|$)/iu.test(head)) {
      return true;
    }
  }
  return false;
}

function firstMatch(text: string, patterns: ReadonlyArray<RegExp>): string | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return (m[0] ?? "").replace(/^\s+/, "");
  }
  return null;
}

function hasNearbyNegation(
  text: string,
  patterns: ReadonlyArray<RegExp>,
): boolean {
  for (const pattern of patterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}
