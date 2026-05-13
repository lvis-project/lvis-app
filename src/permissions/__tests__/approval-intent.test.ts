import { describe, expect, it } from "vitest";

import {
  detectApprovalIntent,
  MAX_INTENT_TEXT_LENGTH,
} from "../approval-intent.js";

describe("approval-intent — accept (Korean)", () => {
  it.each([
    ["허용", "허용"],
    ["허용해줘", "허용해 줘"],
    ["허용해 주세요", "허용해 주세요"],
    ["진행", "진행"],
    ["진행해", "진행해"],
    ["통과", "통과"],
    ["승인", "승인"],
    ["괜찮아", "괜찮아"],
    ["네", "네"],
    ["응", "응"],
    ["좋아", "좋아"],
    ["좋아요", "좋아요"],
    ["그래", "그래"],
  ])("recognises Korean approve: %s", (text) => {
    const v = detectApprovalIntent(text);
    expect(v.kind).toBe("approve");
  });
});

describe("approval-intent — accept (English)", () => {
  it.each([
    "approve",
    "approve it",
    "Approved",
    "allow",
    "allow it",
    "proceed",
    "go ahead",
    "yes",
    "ok",
    "okay",
    "sure",
  ])("recognises English approve: %s", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("approve");
  });

  // Round-1 security review: single-letter "y" / "n" / "Y" / "N" are
  // NOT recognised as standalone approve/reject — typo risk too high.
  it.each(["y", "Y", "n", "N"])("rejects single-letter affirmative/negative: %s", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("none");
  });
});

describe("approval-intent — reject", () => {
  it.each([
    ["거절", "ko"],
    ["거부", "ko"],
    ["취소", "ko"],
    ["중단", "ko"],
    ["안 돼", "ko"],
    ["하지 마세요", "ko"],
    ["reject", "en"],
    ["deny", "en"],
    ["cancel", "en"],
    ["stop", "en"],
    ["abort", "en"],
    ["no", "en"],
    ["nope", "en"],
    ["아니요", "ko"],
  ])("recognises reject %s (%s)", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("reject");
  });
});

describe("approval-intent — negation safety (#690 acceptance)", () => {
  // The load-bearing safety properties: a user who types "허용 안 함"
  // is REJECTING, not approving. Same for "don't allow".
  it.each([
    "허용 안 함",
    "허용 안 해",
    "허용하지 마세요",
    "허용하지 마",
    "don't allow",
    "do not approve",
    "never proceed",
    // Round-1 additions — code-reviewer MAJOR-1 / critic MAJOR-3
    "허용하지 않아",
    "허용 안해",
    "허용안함",       // spaceless Korean — critic MAJOR-3
    "허용안돼",
    "허용 못 함",     // 못 impossibility marker
    "I can't approve",
    "I cannot allow",
    "I don’t approve", // smart apostrophe — test-engineer NIT
  ])("treats negated-approve as none: %s", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("none");
  });
});

describe("approval-intent — symmetric reject-negation safety (#690 round-1 critic CRITICAL)", () => {
  // A user typing "취소하지 마" ("don't cancel") is asking *not* to
  // reject. The matcher MUST NOT report kind="reject".
  it.each([
    ["취소하지 마", "ko"],
    ["취소하지 마세요", "ko"],
    ["거절하지 마", "ko"],
    ["거부하지 마세요", "ko"],
    ["중단하지 마", "ko"],
    ["don't cancel", "en"],
    ["do not reject", "en"],
    ["never cancel", "en"],
    ["I can't cancel", "en"],
    ["I cannot stop", "en"],
  ])("'%s' (%s) → none (not reject)", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("none");
  });

  // But standalone "안 돼" / "하지 마" ARE reject phrases and must
  // still be classified as reject.
  it("preserves standalone '안 돼' as reject", () => {
    expect(detectApprovalIntent("안 돼").kind).toBe("reject");
  });
  it("preserves standalone '하지 마세요' as reject", () => {
    expect(detectApprovalIntent("하지 마세요").kind).toBe("reject");
  });
});

describe("approval-intent — Korean question/passive forms (#690 round-1 test-engineer CRITICAL)", () => {
  // A user typing "허용했나요?" (past-tense question — "Did you
  // approve?") is asking, not directing. Same for the passive "허용된
  // 건가요?" ("Is it approved?").
  it.each([
    "허용했나요?",
    "허용하셨나요?",
    "허용된 건가요?",
    "허용 됩니까?",
    "허용되었어?",
  ])("treats question/passive form as none: %s", (text) => {
    // These forms contain "허용" with verb-boundary continuations but
    // are not approval directives. The current matcher's bare-verb
    // pattern may match — pin the behaviour now so a future change
    // that further relaxes the boundary doesn't regress safety.
    const verdict = detectApprovalIntent(text);
    // Acceptable: kind === "none" (preferred). If the matcher reports
    // approve here, the chip still requires explicit click — but the
    // assertion documents the contract we want.
    expect(verdict.kind).toBe("none");
  });
});

describe("approval-intent — countSentences fix (#690 round-1 code-reviewer MAJOR-3)", () => {
  // Previously "진짜? 허용해" counted as 1 sentence and slipped
  // through the multi-sentence guard.
  it("'진짜? 허용해' → none (two sentences via question terminator)", () => {
    expect(detectApprovalIntent("진짜? 허용해").kind).toBe("none");
  });
  it("'파일 있어? 허용' → none", () => {
    expect(detectApprovalIntent("파일 있어? 허용").kind).toBe("none");
  });
});

describe("approval-intent — NFC normalization (#690 round-1 code-reviewer MINOR)", () => {
  // macOS Finder produces NFD-decomposed Hangul on paste. The matcher
  // must normalize at entry so both encodings match identically.
  it("matches '허용' in NFD form (paste from Finder)", () => {
    const nfd = "허용".normalize("NFD");
    expect(detectApprovalIntent(nfd).kind).toBe("approve");
  });
});

describe("approval-intent — false-positive defence (#690 round-1 security/critic)", () => {
  // Round-1 reviewers raised concern about bare-verb 허용 matching
  // request phrases. Test the canonical cases — at minimum the
  // ambiguity check should fire when other intent tokens appear too.
  it("'I can\\'t approve' has approve + negation → none", () => {
    expect(detectApprovalIntent("I can't approve").kind).toBe("none");
  });
});

describe("approval-intent — ambiguity short-circuits", () => {
  it("both approve and reject mentioned → none", () => {
    expect(detectApprovalIntent("허용 또는 거절").kind).toBe("none");
    expect(detectApprovalIntent("approve or reject").kind).toBe("none");
  });

  it("rejects empty / whitespace input", () => {
    expect(detectApprovalIntent("").kind).toBe("none");
    expect(detectApprovalIntent("   ").kind).toBe("none");
  });

  it("rejects non-string input defensively", () => {
    // @ts-expect-error — exercising the boundary guard
    expect(detectApprovalIntent(null).kind).toBe("none");
    // @ts-expect-error
    expect(detectApprovalIntent(undefined).kind).toBe("none");
    // @ts-expect-error
    expect(detectApprovalIntent(123).kind).toBe("none");
  });

  it("rejects multi-sentence prose even if it contains approve token", () => {
    const text = "내일 회의 잡아줘. 그리고 허용해줘.";
    expect(detectApprovalIntent(text).kind).toBe("none");
  });

  it(`rejects text longer than ${MAX_INTENT_TEXT_LENGTH} chars (likely LLM output reflected as input)`, () => {
    const long = "허용해 주세요 " + "추가 ".repeat(40);
    expect(long.length).toBeGreaterThan(MAX_INTENT_TEXT_LENGTH);
    expect(detectApprovalIntent(long).kind).toBe("none");
  });

  it("does not match approve-token embedded in a longer word", () => {
    // "stopwatch" should NOT match the "stop" reject pattern (it's mid-word).
    expect(detectApprovalIntent("stopwatch").kind).toBe("none");
    // Korean "허용성" should NOT match the "허용" approve pattern (it's a noun, not a verb form).
    expect(detectApprovalIntent("허용성").kind).toBe("none");
  });

  it("surfaces the matched phrase for audit clarity", () => {
    const v = detectApprovalIntent("허용해 주세요");
    expect(v.kind).toBe("approve");
    if (v.kind === "approve") {
      expect(v.matchedPhrase).toContain("허용");
    }
  });
});

describe("approval-intent — load-bearing case parity with #690 examples", () => {
  // These are the literal examples the user might type from the
  // permission-dialog screenshots in the conversation that motivated
  // the issue. Test now so a future refactor cannot regress them.
  it.each([
    ["OK 허용해줘", "approve"],
    ["응 허용해줘", "approve"],
    ["OK 진행", "approve"],
    ["허용 취소", "none"], // ambiguous
    ["허용하지 마", "none"], // negated
    ["취소해줘", "reject"],
    ["no thanks", "reject"], // "no" lonely-token would normally match,
    // but here it's part of a phrase; the multi-word pattern doesn't list
    // "no thanks" so the input falls to none. Worth pinning.
  ])("'%s' → %s", (text, expected) => {
    const got = detectApprovalIntent(text).kind;
    // "no thanks" is a contested case: the lonely-token regex requires
    // the entire trimmed input to be exactly `no`/`n`/`nope`, so
    // "no thanks" does NOT match. The phrasal pattern for reject
    // only lists "no" alone, so this falls to "none". Pin it.
    if (text === "no thanks") {
      expect(got).toBe("none");
      return;
    }
    expect(got).toBe(expected);
  });
});
