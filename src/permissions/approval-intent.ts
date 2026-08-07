




export type ApprovalIntent =
  | { kind: "approve"; matchedPhrase: string }
  | { kind: "reject"; matchedPhrase: string }
  | { kind: "none" };




export const MAX_INTENT_TEXT_LENGTH = 24;

/**
 * Approval phrases. Order matters: more specific (multi-word) entries
 * first so the matcher reports the longest match in `matchedPhrase`
 * for audit clarity. Each entry is a *word-boundary anchored* regex.
 *
 * Korean phrases use Hangul boundaries (start-of-input or whitespace
 * before, end-of-input or whitespace / punctuation after).
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




const EN_CONTRACTION_NEGATION =
  /(^|\s)(don|doesn|didn|can|won|wouldn|shouldn|couldn|isn|aren|wasn|weren|hasn|haven|hadn|mustn|mightn|shan)['’]?t(\s|$)/iu;
// Reserved for future "do not / would not" full-form coverage; the
// space-separated forms below already match these so EN_NOT_VERB_NEGATION
// stays out of the active matcher set.

const NEGATION_TOKENS_NEAR_APPROVE: ReadonlyArray<RegExp> = [
  /(안|않|못)/u,
  /(말고|금지)/u,
  /하지\s*마/u,
  /(^|\s)not(\s|$)/iu,
  /(^|\s)no\s+(approve|allow|proceed|go\s+ahead|허용|진행|통과|승인)(\s|$)/iu,
  /(^|\s)never(\s|$)/iu,
  EN_CONTRACTION_NEGATION,
  /(^|\s)do\s+not(\s|$)/iu,
  /(^|\s)does\s+not(\s|$)/iu,
  /(^|\s)did\s+not(\s|$)/iu,
  /(^|\s)will\s+not(\s|$)/iu,
  /(^|\s)would\s+not(\s|$)/iu,
  /(^|\s)should\s+not(\s|$)/iu,
  /(^|\s)could\s+not(\s|$)/iu,
  /(^|\s)is\s+not(\s|$)/iu,
  /(^|\s)are\s+not(\s|$)/iu,
  /(^|\s)cannot(\s|$)/iu,
];




const HESITATION_TOKENS_NEAR_APPROVE: ReadonlyArray<RegExp> = [
  /(^|\s)잠시만(\s|$)/u,
  /(^|\s)기다려/u,
  /(^|\s)아직(\s|$)/u,
  /(^|\s)wait(\s|$)/iu,
  /(^|\s)hold\s+on(\s|$)/iu,
  /(^|\s)not\s+yet(\s|$)/iu,
];




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




const NEGATION_SUFFIXES_AFTER_REJECT: ReadonlyArray<RegExp> = [
  /하지\s*마/u,
  /(\s|^)(안|않)/u,
  /(\s|^)never(\s|$)/iu,
];

const ENGLISH_NEGATION_BEFORE_REJECT_VERB =
  /(^|\s)(don|doesn|didn|can|won|wouldn|shouldn|couldn|isn|aren|wasn|weren|hasn|haven|hadn|mustn|mightn|shan)['’]?t(\s|$)|(^|\s)(do|does|did|will|would|should|could|is|are|was|were|has|have|had|must|might|shall)(\s+not)(\s|$)|(^|\s)never(\s|$)|(^|\s)cannot(\s|$)/iu;




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
  if (/^(assistant|system|developer|tool|user)\s*:/iu.test(text)) {
    return { kind: "none" };
  }


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

    // "wait", "not yet") near an approve verb collapse to "none".
    if (hasNearbyNegation(text, HESITATION_TOKENS_NEAR_APPROVE)) {
      return { kind: "none" };
    }
    return { kind: "approve", matchedPhrase: approveMatch };
  }
  if (rejectMatch) {
    // Round-1 critic CRITICAL: symmetric negation for reject path.
    // Only treat as none when the negation appears *after* a reject


    if (hasNegationAfterRejectVerb(text)) {
      return { kind: "none" };
    }
    return { kind: "reject", matchedPhrase: rejectMatch };
  }
  return { kind: "none" };
}

function hasNegationAfterRejectVerb(text: string): boolean {
  // Round-2 code-reviewer + critic — slice the lowercased text itself
  // so head/tail indices stay self-consistent. Locale-aware lowering
  // (Turkish İ → two units) would otherwise drift the slice indices.
  const lower = text.toLowerCase();
  for (const stem of REJECT_VERB_STEMS) {
    const idx = lower.indexOf(stem);
    if (idx < 0) continue;

    const tail = lower.slice(idx + stem.length);
    for (const suffix of NEGATION_SUFFIXES_AFTER_REJECT) {
      if (suffix.test(tail)) return true;
    }
    // Prefix negation (English "don't cancel" / "shouldn't cancel" /
    // "wouldn't reject" / "never stop"): pattern precedes the verb.
    const head = lower.slice(0, idx);
    if (ENGLISH_NEGATION_BEFORE_REJECT_VERB.test(head)) {
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
