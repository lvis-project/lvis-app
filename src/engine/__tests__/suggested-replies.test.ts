/**
 * Tests for the suggested-replies parser + streaming filter.
 * See `docs/architecture/proposals/suggested-replies-ghost-text.md`.
 */
import { describe, it, expect } from "vitest";
import {
  createStreamingFilter,
  parseSuggestedReplies,
  stripSuggestedReplies,
} from "../suggested-replies.js";

describe("parseSuggestedReplies", () => {
  it("returns [] when no block is present", () => {
    expect(parseSuggestedReplies("plain text response")).toEqual([]);
  });

  it("extracts a 3-item block", () => {
    const raw = [
      "응답 본문.",
      "",
      "<suggested_replies>",
      "- 다음 단계로 진행",
      "- 다른 옵션 보기",
      "- 취소",
      "</suggested_replies>",
    ].join("\n");
    expect(parseSuggestedReplies(raw)).toEqual([
      "다음 단계로 진행",
      "다른 옵션 보기",
      "취소",
    ]);
  });

  it("ignores blank lines inside the block", () => {
    const raw = "<suggested_replies>\n- a\n\n- b\n</suggested_replies>";
    expect(parseSuggestedReplies(raw)).toEqual(["a", "b"]);
  });

  it("caps results at 5 items (matches SUGGESTED_REPLIES_INSTRUCTION upper bound)", () => {
    const raw =
      "<suggested_replies>\n- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n</suggested_replies>";
    expect(parseSuggestedReplies(raw)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("drops candidates over 80 characters (parser safety cap above 40~60자 recommended length)", () => {
    const tooLong = "x".repeat(90);
    const raw = `<suggested_replies>\n- short\n- ${tooLong}\n- ok\n</suggested_replies>`;
    expect(parseSuggestedReplies(raw)).toEqual(["short", "ok"]);
  });

  it("tolerates bullet variants (•, *, dash, spaces)", () => {
    const raw = "<suggested_replies>\n* a\n• b\n  -   c\n</suggested_replies>";
    expect(parseSuggestedReplies(raw)).toEqual(["a", "b", "c"]);
  });
});

describe("stripSuggestedReplies", () => {
  it("removes the trailing block and surrounding whitespace", () => {
    const raw = "본문입니다.\n\n<suggested_replies>\n- a\n- b\n</suggested_replies>";
    expect(stripSuggestedReplies(raw)).toBe("본문입니다.");
  });

  it("is a no-op when no block exists", () => {
    expect(stripSuggestedReplies("그냥 텍스트")).toBe("그냥 텍스트");
  });

  it("removes a mid-text block (defensive — should not happen in practice)", () => {
    // Mid-text occurrences shouldn't happen in well-behaved model output.
    // When they do, we strip aggressively (surrounding whitespace included)
    // — the priority is "no raw tag reaches the user", not preserving the
    // exact line spacing of malformed output.
    const raw = "before\n<suggested_replies>\n- x\n</suggested_replies>\nafter";
    expect(stripSuggestedReplies(raw)).toBe("beforeafter");
  });

  it("strips an unclosed trailing block (vendor malformation guard)", () => {
    // GPT / Gemini occasionally truncate before the closing tag. Without
    // this guard the open tag would survive into ~/.lvis/sessions JSONL and
    // re-feed as context on every subsequent turn — the same leak class as
    // M3 from the PR #807 review.
    const raw = "본문\n<suggested_replies>\n- a";
    expect(stripSuggestedReplies(raw)).toBe("본문");
  });

  it("removes multiple blocks (defensive — model malformation or history echo)", () => {
    // If a prior turn's block survived into history and the next turn echoes
    // it back ALONGSIDE a freshly emitted block, both must be removed before
    // re-persistence — otherwise blocks would compound across turns.
    const raw = [
      "본문",
      "<suggested_replies>",
      "- old",
      "</suggested_replies>",
      "<suggested_replies>",
      "- new",
      "</suggested_replies>",
    ].join("\n");
    expect(stripSuggestedReplies(raw)).toBe("본문");
  });
});

describe("createStreamingFilter", () => {
  function feedAll(filter: ReturnType<typeof createStreamingFilter>, chunks: string[]): string {
    return chunks.map((c) => filter.feed(c)).join("");
  }

  it("passes plain text through unchanged", () => {
    const f = createStreamingFilter();
    expect(feedAll(f, ["hello ", "world"])).toBe("hello world");
    expect(f.finish()).toEqual({ trailing: "", suggestedReplies: [] });
  });

  it("withholds the tag and emits parsed list at finish()", () => {
    const f = createStreamingFilter();
    const visible = feedAll(f, [
      "본문",
      "\n\n<suggested_replies>\n- 예\n- 아니오\n</suggested_replies>",
    ]);
    expect(visible).toBe("본문");
    expect(f.finish()).toEqual({ trailing: "", suggestedReplies: ["예", "아니오"] });
  });

  it("handles the open tag split across chunk boundaries", () => {
    const f = createStreamingFilter();
    // The "<sugg" suffix could be a partial open tag — it must NOT leak to
    // the visible stream while we wait for the rest.
    expect(f.feed("body text <sugg")).toBe("body text ");
    expect(f.feed("ested_replies>\n- ok\n</suggested_replies>")).toBe("");
    expect(f.finish().suggestedReplies).toEqual(["ok"]);
  });

  it("treats a partial-tag suffix that turns out to be plain text as visible", () => {
    const f = createStreamingFilter();
    // "<sugg" looks like a prefix, but the next chunk diverges — emit it.
    expect(f.feed("see <sugg")).toBe("see ");
    expect(f.feed("ar in coffee")).toBe("<suggar in coffee");
    expect(f.finish()).toEqual({ trailing: "", suggestedReplies: [] });
  });

  it("returns trailing pending on stream end without a block", () => {
    const f = createStreamingFilter();
    // Stream ends with a partial-tag suffix — still emitted as plain text.
    expect(f.feed("done <sug")).toBe("done ");
    expect(f.finish()).toEqual({ trailing: "<sug", suggestedReplies: [] });
  });

  it("drops the partial block silently when the stream aborts mid-block", () => {
    const f = createStreamingFilter();
    expect(f.feed("hi\n<suggested_replies>\n- a")).toBe("hi");
    // Stream aborts here — block never closed. Parser returns [] and trailing
    // is empty so the renderer sees nothing leftover.
    expect(f.finish()).toEqual({ trailing: "", suggestedReplies: [] });
  });
});
