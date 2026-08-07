




/**
 * Grant breadth a sentence can ask for. Ordered narrow → wide; the
 * ordering is load-bearing (see {@link NARROWEST_SCOPE} and the
 * mixed-scope rule in {@link parseScopeSlot}).
 */
export type ApprovalGrantScope = "once" | "session" | "always";

/** The narrowest grant. Every ambiguous parse resolves here. */
export const NARROWEST_SCOPE: ApprovalGrantScope = "once";

/**
 * Scope slot of a parsed sentence.
 *
 * `explicit` is the only field a caller may use to decide whether the
 * sentence asked to widen anything. `value` is ALWAYS safe to apply
 * directly: when the sentence is ambiguous, mixes scopes, or names none,
 * `value` is {@link NARROWEST_SCOPE} and `explicit` is false.
 */
export interface ApprovalIntentScope {
  value: ApprovalGrantScope;
  explicit: boolean;
  /** The literal phrase that selected `value`; "" when not explicit. */
  matchedPhrase: string;
}

/**
 * Target slot of a parsed sentence.
 *
 * `kind: "none"` is the default and covers demonstratives ("그 경로",
 * "that path"). It is NOT a failure: the host already knows the path the
 * request is about, and a demonstrative means "the one you are asking me
 * about". Callers resolve `"none"` against the request's own target, which
 * is why the confirmation line can name a concrete path the host derived
 * rather than one the user typed.
 *
 * `kind: "path"` means the user typed an explicit absolute path. It is
 * RAW, unresolved and untrusted — the caller MUST validate it against the
 * request's own target before it can select a grant, and must never widen
 * a grant to it on the parser's say-so.
 */
export type ApprovalIntentTarget =
  | { kind: "none" }
  | { kind: "path"; raw: string };

export type ApprovalIntent =
  | {
      kind: "approve";
      matchedPhrase: string;
      scope: ApprovalIntentScope;
      target: ApprovalIntentTarget;
    }
  | { kind: "reject"; matchedPhrase: string }
  | { kind: "none" };

/**
 * Length cut for a PLAIN approve/reject sentence.
 *
 * This is a false-positive guard, not a formatting rule: "허용"-class verbs
 * occur in ordinary chatter, and a long sentence containing one is far more
 * likely to be conversation than a directive. Measured examples that this
 * cut is here to drop: "음 승인은 아직 잘 모르겠고 나중에 다시 볼게" (25).
 */
export const MAX_INTENT_TEXT_LENGTH = 24;

/**
 * Length cut once a scope or target slot is filled.
 *
 * A sentence that names a scope or an absolute path is structurally a
 * directive — the slot fill is itself the evidence of intent, which is what
 * buys the extra length. The relaxation is safe ONLY because a slot-filled
 * parse can never take effect without the caller's explicit confirmation
 * step; it widens what the matcher will *offer*, never what it grants.
 */
export const MAX_SCOPED_INTENT_TEXT_LENGTH = 96;

/** Upper bound on a raw target path, to keep an absurd token out of the UI. */
const MAX_TARGET_PATH_LENGTH = 260;

export interface DetectApprovalIntentOptions {
  /** Override for {@link MAX_INTENT_TEXT_LENGTH}. */
  maxLength?: number;
  /** Override for {@link MAX_SCOPED_INTENT_TEXT_LENGTH}. */
  maxScopedLength?: number;
}

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




// ─── Scope slot ───────────────────────────────────────────────────────────────

/**
 * Scope lexicon, one entry per grant breadth.
 *
 * Deliberately ABSENT from the "always" family: "계속" / "continue". Both
 * ordinarily mean "keep going with what you were doing" — "계속 진행해 주세요"
 * is a plain approve, not a request for a standing grant. Reading them as
 * "always" would turn the single most common approval phrasing in the corpus
 * into a permanent grant, which is the exact escalation this feature must not
 * introduce.
 */
const SCOPE_END = "(?=[\\s,;.!?]|$)";

const SCOPE_PATTERNS: ReadonlyArray<readonly [ApprovalGrantScope, RegExp]> = [
  ["once", /이번\s*(턴|번)?\s*만(\s*동안)?/u],
  ["once", /한\s*번만/u],
  ["once", /이번\s*한\s*번/u],
  ["once", new RegExp(`(^|\\s)once${SCOPE_END}`, "iu")],
  ["once", new RegExp(`(^|\\s)just\\s+this\\s+(time|once|turn)${SCOPE_END}`, "iu")],
  [
    "once",
    new RegExp(`(^|\\s)(only\\s+)?this\\s+(time|turn)(\\s+only)?${SCOPE_END}`, "iu"),
  ],
  ["session", /이번\s*세션(\s*동안)?/u],
  ["session", /이\s*세션(\s*동안)?/u],
  ["session", /(^|\s)세션(\s*동안)?/u],
  ["session", new RegExp(`(^|\\s)(for\\s+)?(this|the)\\s+session${SCOPE_END}`, "iu")],
  ["session", new RegExp(`(^|\\s)session${SCOPE_END}`, "iu")],
  ["always", /항상/u],
  ["always", /영구/u],
  ["always", /앞으로/u],
  ["always", new RegExp(`(^|\\s)always${SCOPE_END}`, "iu")],
  ["always", new RegExp(`(^|\\s)(permanent|permanently|forever)${SCOPE_END}`, "iu")],
  ["always", new RegExp(`(^|\\s)from\\s+now\\s+on${SCOPE_END}`, "iu")],
];

/**
 * Blank every scope phrase, for the negation scan only.
 *
 * `NEGATION_TOKENS_NEAR_APPROVE` matches "안" as a bare substring, so the
 * duration marker "동안" reads as a negation and kills the sentence: before
 * this, "이번 세션 동안 허용" — the issue's own example phrasing — returned
 * "none". Scope phrases are a closed lexicon that carries no negation, so
 * removing them from the negation scan cannot hide a real negation; the
 * approve/reject verbs are still matched against the unmodified text.
 * Replacement is length-preserving so the surrounding `(^|\s)` boundaries in
 * the negation patterns keep their meaning.
 */
function maskScopePhrases(text: string): string {
  let out = text;
  for (const [, pattern] of SCOPE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, `${pattern.flags}g`), (m) =>
      " ".repeat(m.length),
    );
  }
  return out;
}

const UNRESOLVED_SCOPE: ApprovalIntentScope = {
  value: NARROWEST_SCOPE,
  explicit: false,
  matchedPhrase: "",
};

/**
 * Resolve the scope slot.
 *
 * A scope is explicit only when the sentence names EXACTLY ONE breadth. A
 * sentence naming two ("이번 턴만 허용하고 앞으로도 계속") is refused outright
 * rather than reconciled: picking a winner between two stated intentions is a
 * guess, and a wrong guess here is a permission escalation. Refusal lands on
 * {@link NARROWEST_SCOPE} with `explicit: false`, so the caller offers nothing
 * broader than the plain approve that already exists today.
 */
function parseScopeSlot(text: string): ApprovalIntentScope {
  const found = new Map<ApprovalGrantScope, string>();
  for (const [scope, pattern] of SCOPE_PATTERNS) {
    if (found.has(scope)) continue;
    const m = text.match(pattern);
    if (m) found.set(scope, (m[0] ?? "").trim());
  }
  if (found.size !== 1) return UNRESOLVED_SCOPE;
  const [[value, matchedPhrase]] = [...found.entries()];
  return { value, explicit: true, matchedPhrase };
}

// ─── Target slot ──────────────────────────────────────────────────────────────

/**
 * Absolute-path-shaped tokens. Relative fragments and demonstratives are
 * intentionally not candidates — see {@link ApprovalIntentTarget}.
 */
const PATH_CANDIDATE = /[A-Za-z]:[\\/][^\s"'`]*|\/[^\s"'`]*/gu;

const TRAILING_PUNCTUATION = /[.,!?;:。]+$/u;

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/u;

function collectPathCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_CANDIDATE)) {
    const raw = (m[0] ?? "").replace(TRAILING_PUNCTUATION, "");
    if (raw.length > 0) out.push(raw);
  }
  return out;
}

function isFilesystemRootToken(candidate: string): boolean {
  if (candidate === "/") return true;
  return /^[A-Za-z]:[\\/]?$/u.test(candidate);
}

/**
 * Resolve the target slot from an already-collected candidate list.
 *
 * Every rejection below returns `{ kind: "none" }`, which is not a dead end:
 * the caller falls back to the path the HOST already knows the request is
 * about. So a refused target narrows the grant to the request's own target
 * instead of the one the user typed — never the other way round.
 */
function parseTargetSlot(candidates: readonly string[]): ApprovalIntentTarget {
  const distinct = [...new Set(candidates)];
  // Two paths in one sentence: which one the scope attaches to is a guess.
  if (distinct.length !== 1) return { kind: "none" };
  const raw = distinct[0]!;
  if (raw.length > MAX_TARGET_PATH_LENGTH) return { kind: "none" };
  // A bare root would widen a grant to the entire filesystem / volume.
  if (isFilesystemRootToken(raw)) return { kind: "none" };
  // Traversal — `/srv/app/../../etc` reads narrow and resolves wide. The
  // caller re-validates too, but a token that cannot be read literally has
  // no business reaching a confirmation line that claims to be concrete.
  if (raw.split(/[\\/]/u).some((seg) => seg === "..")) return { kind: "none" };
  // Percent-encoding can hide traversal (`%2e%2e`) from a literal read.
  if (raw.includes("%")) return { kind: "none" };
  // Globs do not name one path.
  if (/[*?[\]]/u.test(raw)) return { kind: "none" };
  // URLs are not filesystem targets. A doubled leading separator covers
  // both the tail of a URL authority ("https://host/x" yields "//host/x")
  // and a UNC share, which names a whole remote volume.
  if (raw.includes("://")) return { kind: "none" };
  if (raw.startsWith("//") || raw.startsWith("\\\\")) return { kind: "none" };
  // Control characters, including the NUL truncation trick.
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return { kind: "none" };
  // Hangul inside a path token cannot be split from an attached particle
  // ("/etc만" — is the path `/etc` or `/etc만`?). Rather than guess a
  // morpheme boundary, drop the target and let the host's own path stand.
  if (HANGUL.test(raw)) return { kind: "none" };
  return { kind: "path", raw };
}

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
 * Blank out path-shaped tokens before sentence counting.
 *
 * A dotted filename ("/etc/hosts.conf") otherwise reads as a sentence
 * terminator with content on both sides, so an entirely well-formed
 * directive would be discarded as multi-sentence. Masking only removes
 * punctuation that lives INSIDE a path token, so it cannot merge two real
 * sentences into one.
 */
function maskPathCandidates(text: string, candidates: readonly string[]): string {
  let out = text;
  for (const candidate of candidates) {
    out = out.split(candidate).join("_".repeat(candidate.length));
  }
  return out;
}

/**
 * Detect natural-language approval intent.
 *
 * @param rawText raw user-keyboard text (do not pre-trim; the matcher
 *                handles whitespace + boundary cases itself).
 * @returns       discrete verdict. Caller MUST require an explicit user
 *                gesture (e.g. chip click) before acting on `"approve"`
 *                or `"reject"` — see module docstring. When the verdict is
 *                `"approve"`, a `scope.explicit` parse additionally requires
 *                the caller to show the resolved scope and target back to
 *                the user and take a separate confirmation gesture.
 */
export function detectApprovalIntent(
  rawText: string,
  options: DetectApprovalIntentOptions = {},
): ApprovalIntent {
  if (typeof rawText !== "string") return { kind: "none" };
  // Normalize composed/decomposed Hangul + Latin so paste-from-Finder
  // (NFD) and typed text (NFC) produce identical match results.
  // Round-1 code-reviewer finding (unicode normalization).
  const text = rawText.normalize("NFC").trim();
  if (text.length === 0) return { kind: "none" };
  if (/^(assistant|system|developer|tool|user)\s*:/iu.test(text)) {
    return { kind: "none" };
  }

  // The presence of any question mark (ASCII or full-width) forces
  // "none" — a user issuing a directive does not append "?".
  if (/[?？]/u.test(text)) return { kind: "none" };

  const pathCandidates = collectPathCandidates(text);
  if (countSentences(maskPathCandidates(text, pathCandidates)) > 1) {
    return { kind: "none" };
  }

  // Slots are parsed BEFORE the length cut because a filled slot is what
  // earns the longer cut. Parsing is pure and side-effect free, so doing it
  // for text that is about to be discarded costs nothing.
  const scope = parseScopeSlot(text);
  const target = parseTargetSlot(pathCandidates);
  const maxLength = options.maxLength ?? MAX_INTENT_TEXT_LENGTH;
  const maxScopedLength = options.maxScopedLength ?? MAX_SCOPED_INTENT_TEXT_LENGTH;
  const slotFilled = scope.explicit || target.kind === "path";
  if (text.length > (slotFilled ? maxScopedLength : maxLength)) {
    return { kind: "none" };
  }

  const approveMatch = firstMatch(text, APPROVE_PATTERNS);
  const rejectMatch = firstMatch(text, REJECT_PATTERNS);

  // Both matched ⇒ ambiguous ⇒ none (rule 2).
  if (approveMatch && rejectMatch) return { kind: "none" };

  if (approveMatch) {
    // Scope phrases are excluded from the negation scan — see
    // maskScopePhrases(). The approve verb above was matched against the
    // unmodified text.
    const negationScanText = maskScopePhrases(text);
    if (hasNearbyNegation(negationScanText, NEGATION_TOKENS_NEAR_APPROVE)) {
      return { kind: "none" };
    }

    // "wait", "not yet") near an approve verb collapse to "none".
    if (hasNearbyNegation(negationScanText, HESITATION_TOKENS_NEAR_APPROVE)) {
      return { kind: "none" };
    }
    return { kind: "approve", matchedPhrase: approveMatch, scope, target };
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
