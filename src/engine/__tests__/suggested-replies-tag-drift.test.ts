/**
 * A one-character deviation in the tag must not put raw markup on screen.
 *
 * Observed: the model emitted `< suggested_replies>` — a space between the
 * bracket and the name. Matching was literal, so the opening tag was never
 * found: the streaming filter passed the block straight through, and the user
 * saw the markup, the bullet list and the trailing `</suggested_replies>`
 * rendered as message text instead of getting reply chips.
 *
 * The failure mode matters more than the typo. Tag spelling is model output —
 * i.e. it drifts — so exact-match parsing turns a cosmetic deviation into a
 * visible defect. Degrading to "no suggestions" is acceptable; leaking the
 * block is not.
 *
 * These cover all three consumers, because a spelling one accepts and another
 * leaks is the same bug with extra steps.
 */
import { describe, expect, it } from "vitest";

import {
  createStreamingFilter,
  parseSuggestedReplies,
  stripSuggestedReplies,
} from "../suggested-replies.js";

/** The exact drift seen in the wild, plus the neighbouring shapes. */
const DRIFTED_OPEN = [
  "< suggested_replies>",
  "<suggested_replies >",
  "< suggested_replies >",
  "<\nsuggested_replies>",
] as const;

const DRIFTED_CLOSE = [
  "</ suggested_replies>",
  "< /suggested_replies>",
  "</suggested_replies >",
] as const;

function block(open: string, close: string): string {
  return `${open}\n- first reply\n- second reply\n${close}`;
}

describe("suggested-replies tag drift", () => {
  it.each(DRIFTED_OPEN)("parses a block opened with %j", (open) => {
    expect(parseSuggestedReplies(block(open, "</suggested_replies>"))).toEqual([
      "first reply",
      "second reply",
    ]);
  });

  it.each(DRIFTED_CLOSE)("parses a block closed with %j", (close) => {
    expect(parseSuggestedReplies(block("<suggested_replies>", close))).toEqual([
      "first reply",
      "second reply",
    ]);
  });

  it.each(DRIFTED_OPEN)("strips a drifted block from persisted text (%j)", (open) => {
    const raw = `answer text\n\n${block(open, "</suggested_replies>")}`;
    const stripped = stripSuggestedReplies(raw);
    expect(stripped).toBe("answer text");
    // Nothing tag-shaped may survive into ~/.lvis/sessions, or it re-feeds to
    // the LLM as context every turn.
    expect(stripped).not.toMatch(/suggested_replies/);
  });

  it.each(DRIFTED_OPEN)("withholds a drifted block from the visible stream (%j)", (open) => {
    const filter = createStreamingFilter();
    const visible =
      filter.feed("answer text\n\n") + filter.feed(block(open, "</suggested_replies>"));
    // Asserted on content, not exact trailing whitespace: prose emitted in an
    // EARLIER chunk is already gone by the time the tag arrives, so the
    // newline-trim only reaches text in the same chunk. That is pre-existing
    // behaviour, identical with the literal tag, and not what this is testing.
    expect(visible).toContain("answer text");
    expect(visible).not.toMatch(/suggested_replies|first reply/);
    expect(filter.finish().suggestedReplies).toEqual(["first reply", "second reply"]);
  });

  it("holds back a drifted tag split across chunks", () => {
    // The part a tolerant regex alone does NOT fix: if the filter cannot tell
    // that "< sugg" might still become a tag, it emits the fragment and only
    // swallows the rest — so the user sees a stray "< sugg" on screen.
    const filter = createStreamingFilter();
    let visible = filter.feed("answer text\n\n< sugg");
    // The fragment must NOT have been emitted — that is the whole point.
    expect(visible).not.toContain("<");
    visible += filter.feed("ested_replies>\n- only reply\n</suggested_replies>");
    expect(visible).toContain("answer text");
    expect(visible).not.toMatch(/suggested_replies|only reply/);
    expect(filter.finish().suggestedReplies).toEqual(["only reply"]);
  });

  it("does not hold back ordinary text that merely starts with a bracket", () => {
    // The tolerance must not swallow prose. `<b` cannot grow into the tag.
    const filter = createStreamingFilter();
    const visible = filter.feed("compare <b> and <i>");
    expect(visible).toBe("compare <b> and <i>");
  });

  it("does not buffer without bound after a stray bracket", () => {
    // A `<` followed by a wall of whitespace must not make the filter hold the
    // rest of the turn hostage.
    const filter = createStreamingFilter();
    const visible = filter.feed(`start <${" ".repeat(200)}not a tag`);
    expect(visible).toContain("start");
    expect(visible).toContain("not a tag");
  });
});
