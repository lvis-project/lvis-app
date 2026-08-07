import { describe, expect, it } from "vitest";

import { detectApprovalIntent } from "../approval-intent.js";

/**
 * The Korean negation adverb `안` used to be matched as a bare substring, so
 * any ordinary word ending in `안` suppressed an approval. These drive the real
 * producer — `detectApprovalIntent` on the sentence a user would actually type.
 */
describe("approval-intent — `안` inside a word is not a negation", () => {
  it.each([
    // The phrasing in issue #1940's own title. Returned "none" before the fix,
    // which made the natural-language chip silently dead for it.
    "이번 세션 동안 허용",
    "이 세션 동안 허용",
    "제안 허용",
    "방안 허용",
    "편안하게 허용",
    "그동안 승인",
  ])("approves despite a word-internal 안: %s", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("approve");
  });
});

describe("approval-intent — real 안 negations still suppress approval", () => {
  it.each([
    // `안` as a free-standing adverb: separated, or at the head of a word.
    "허용 안 해",
    "허용 안돼",
    "허용 안 됩니다",
    "승인 안 함",
  ])("still refuses: %s", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("none");
  });

  it("still refuses a 안-negation when the sentence also contains a 동안", () => {
    // The fix must not let a word-internal 안 elsewhere in the sentence
    // "cover for" a real negation.
    expect(detectApprovalIntent("이번 세션 동안 허용 안 해").kind).toBe("none");
  });
});

describe("approval-intent — 않 and 못 negations are untouched", () => {
  it.each([
    // `않` legitimately follows a verb stem — anchoring it the same way would
    // turn a real negation into an approval, so it stays unanchored.
    "허용하지 않는다",
    "허용하지 않음",
    "승인 못 해",
    "허용 못함",
  ])("still refuses: %s", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("none");
  });
});

describe("approval-intent — unrelated verdicts unchanged", () => {
  it.each(["허용", "승인한다", "진행해", "approve", "allow"])(
    "still approves: %s",
    (text) => {
      expect(detectApprovalIntent(text).kind).toBe("approve");
    },
  );

  it.each(["거부한다", "취소", "reject", "안 돼"])("still rejects: %s", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("reject");
  });
});
