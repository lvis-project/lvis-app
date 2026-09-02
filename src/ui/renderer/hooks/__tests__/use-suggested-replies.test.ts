// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSuggestedReplies,
  pushSuggestedReply,
  dismissSuggestedReplies,
  acceptSuggestedReply,
  clearDismissedReplies,
  resetSuggestedReplies,
  __resetSuggestedRepliesStoreForTests,
  __teardownSuggestedRepliesIpcForTests,
} from "../use-suggested-replies.js";
import {
  getSuggestedRepliesCounters,
  resetSuggestedRepliesCountersForTesting,
} from "../../../../telemetry/suggested-replies-counter.js";

describe("useSuggestedReplies", () => {
  beforeEach(() => {
    __resetSuggestedRepliesStoreForTests();
    __teardownSuggestedRepliesIpcForTests();
    resetSuggestedRepliesCountersForTesting();
  });

  it("starts with empty snapshot", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    expect(result.current).toEqual({ text: null, isDismissed: false });
  });

  it("push a reply → snapshot carries it", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    expect(result.current.text).toBe("네");
    expect(result.current.isDismissed).toBe(false);
  });

  it("push null → resets to empty snapshot", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("a"); });
    expect(result.current.text).toBe("a");
    act(() => { pushSuggestedReply(null); });
    expect(result.current.text).toBeNull();
  });

  it("dismiss marks isDismissed without clearing", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    act(() => { dismissSuggestedReplies(); });
    expect(result.current.isDismissed).toBe(true);
    expect(result.current.text).toBe("네");
  });

  it("dismiss is no-op when nothing is active", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { dismissSuggestedReplies(); });
    expect(result.current.isDismissed).toBe(false);
  });

  it("accept clears snapshot", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    act(() => { acceptSuggestedReply(); });
    expect(result.current.text).toBeNull();
    expect(result.current.isDismissed).toBe(false);
  });

  it("new push after dismiss preserves dismissed flag (turn-scoped memory)", () => {
    // Intra-turn re-push must honor the user's prior Escape. Only
    // `clearDismissedReplies()` (called by Composer on send) or
    // `acceptSuggestedReply()` releases the latch.
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    act(() => { dismissSuggestedReplies(); });
    expect(result.current.isDismissed).toBe(true);
    act(() => { pushSuggestedReply("다음 단계"); });
    expect(result.current.isDismissed).toBe(true);
    expect(result.current.text).toBe("다음 단계");
  });

  it("clearDismissedReplies releases the latch — next push renders fresh", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    act(() => { dismissSuggestedReplies(); });
    expect(result.current.isDismissed).toBe(true);
    act(() => { clearDismissedReplies(); });
    act(() => { pushSuggestedReply("다음 단계"); });
    expect(result.current.isDismissed).toBe(false);
    expect(result.current.text).toBe("다음 단계");
  });

  it("accept also releases the dismiss latch", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    act(() => { dismissSuggestedReplies(); });
    act(() => { acceptSuggestedReply(); });
    act(() => { pushSuggestedReply("다음 단계"); });
    expect(result.current.isDismissed).toBe(false);
  });

  it("multiple subscribers see the same snapshot", () => {
    const { result: r1 } = renderHook(() => useSuggestedReplies());
    const { result: r2 } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    expect(r1.current.text).toBe("네");
    expect(r2.current.text).toBe("네");
    expect(r1.current).toBe(r2.current); // identical reference
  });

  // --- command-prefix filter + telemetry ---

  it("slash-command with arguments is filtered out (executable payload)", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("/admin run prod"); });
    expect(result.current.text).toBeNull();
  });

  it("single-token slash command is filtered out (#980)", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("/clear"); });
    expect(result.current.text).toBeNull();
    act(() => { pushSuggestedReply("/help"); });
    expect(result.current.text).toBeNull();
    act(() => { pushSuggestedReply("상태를 다시 확인해줘"); });
    expect(result.current.text).toBe("상태를 다시 확인해줘");
  });

  it("bang commands and dollar env assignments are filtered out", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    for (const payload of ["!ls", "$ENV=value", "!shell -c rm", "$env=foo bar"]) {
      act(() => { pushSuggestedReply(payload); });
      expect(result.current.text).toBeNull();
    }
    act(() => { pushSuggestedReply("다음"); });
    expect(result.current.text).toBe("다음");
  });

  it("natural dollar-prefixed prose is not treated as an env assignment", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("$100 예산으로 다시 계산해줘"); });
    expect(result.current.text).toBe("$100 예산으로 다시 계산해줘");
  });

  it("a command-prefixed push clears a prior active suggestion", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("확인"); });
    act(() => { pushSuggestedReply("!ls -la /"); });
    expect(result.current).toEqual({ text: null, isDismissed: false });
  });

  it("command-with-args + leading whitespace still filtered (trim before match)", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("  /admin run prod"); });
    expect(result.current.text).toBeNull();
  });

  it("whitespace-only reply collapses to empty", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("   "); });
    expect(result.current.text).toBeNull();
  });

  it("telemetry: shown counter increments on non-empty push", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    expect(getSuggestedRepliesCounters().shown).toBe(1);
  });

  it("telemetry: dismissed counter increments on dismiss", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    act(() => { dismissSuggestedReplies(); });
    expect(getSuggestedRepliesCounters().dismissed).toBe(1);
  });

  it("telemetry: accepted counter increments on accept", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("네"); });
    act(() => { acceptSuggestedReply(); });
    expect(getSuggestedRepliesCounters().accepted).toBe(1);
  });

  it("telemetry: accept on an empty store records nothing", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { acceptSuggestedReply(); });
    expect(getSuggestedRepliesCounters().accepted).toBe(0);
  });

  it("telemetry: ignored counter increments when prior active push is replaced", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("첫 번째"); });
    act(() => { pushSuggestedReply("두 번째"); });
    expect(getSuggestedRepliesCounters().ignored).toBe(1);
  });

  it("telemetry: dismissed snapshot is NOT counted as ignored on next push", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("첫"); });
    act(() => { dismissSuggestedReplies(); });
    act(() => { clearDismissedReplies(); });
    act(() => { pushSuggestedReply("둘"); });
    expect(getSuggestedRepliesCounters().ignored).toBe(0);
    expect(getSuggestedRepliesCounters().dismissed).toBe(1);
  });

  it("resetSuggestedReplies clears an active snapshot and notifies subscribers", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("첫"); });
    expect(result.current.text).toBe("첫");

    act(() => { resetSuggestedReplies(); });

    expect(result.current).toEqual({ text: null, isDismissed: false });
  });

  it("resetSuggestedReplies releases the dismiss latch so the next conversation renders fresh", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("첫"); });
    act(() => { dismissSuggestedReplies(); });

    act(() => { resetSuggestedReplies(); });
    act(() => { pushSuggestedReply("새 대화의 제안"); });

    expect(result.current.text).toBe("새 대화의 제안");
    expect(result.current.isDismissed).toBe(false);
  });

  it("resetSuggestedReplies does not record an ignored event — leaving a conversation is not passing one over", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("첫"); });
    act(() => { resetSuggestedReplies(); });
    act(() => { pushSuggestedReply("둘"); });
    expect(getSuggestedRepliesCounters().ignored).toBe(0);
  });

  it("telemetry: shown is NOT counted when push lands while dismiss latch is set", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReply("첫"); }); // shown=1
    act(() => { dismissSuggestedReplies(); });    // dismissed=1, latch on
    act(() => { pushSuggestedReply("둘"); }); // dismissed snapshot, NOT shown
    expect(getSuggestedRepliesCounters().shown).toBe(1);
  });
});
