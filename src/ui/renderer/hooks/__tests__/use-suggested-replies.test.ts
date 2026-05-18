// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSuggestedReplies,
  pushSuggestedReplies,
  dismissSuggestedReplies,
  acceptSuggestedReply,
  clearDismissedReplies,
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
    expect(result.current).toEqual({ best: null, alternates: [], isDismissed: false });
  });

  it("push 3 replies → best + 2 alternates", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네", "아니오", "나중에"]); });
    expect(result.current.best).toBe("네");
    expect(result.current.alternates).toEqual(["아니오", "나중에"]);
    expect(result.current.isDismissed).toBe(false);
  });

  it("push 1 reply → only best, empty alternates", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네"]); });
    expect(result.current.best).toBe("네");
    expect(result.current.alternates).toEqual([]);
  });

  it("push empty → resets to empty snapshot", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["a", "b"]); });
    expect(result.current.best).toBe("a");
    act(() => { pushSuggestedReplies([]); });
    expect(result.current.best).toBeNull();
    expect(result.current.alternates).toEqual([]);
  });

  it("dismiss marks isDismissed without clearing", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네", "아니오"]); });
    act(() => { dismissSuggestedReplies(); });
    expect(result.current.isDismissed).toBe(true);
    expect(result.current.best).toBe("네");
  });

  it("dismiss is no-op when nothing is active", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { dismissSuggestedReplies(); });
    expect(result.current.isDismissed).toBe(false);
  });

  it("accept clears snapshot", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네", "아니오"]); });
    act(() => { acceptSuggestedReply("네"); });
    expect(result.current.best).toBeNull();
    expect(result.current.alternates).toEqual([]);
    expect(result.current.isDismissed).toBe(false);
  });

  it("new push after dismiss preserves dismissed flag (PR-D turn-scoped memory)", () => {
    // Spec PR-D #3: intra-turn re-push must honor the user's prior Escape.
    // Only `clearDismissedReplies()` (called by Composer on send) or
    // `acceptSuggestedReply()` releases the latch.
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네"]); });
    act(() => { dismissSuggestedReplies(); });
    expect(result.current.isDismissed).toBe(true);
    act(() => { pushSuggestedReplies(["다음 단계"]); });
    expect(result.current.isDismissed).toBe(true);
    expect(result.current.best).toBe("다음 단계");
  });

  it("clearDismissedReplies releases the latch — next push renders fresh", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네"]); });
    act(() => { dismissSuggestedReplies(); });
    expect(result.current.isDismissed).toBe(true);
    act(() => { clearDismissedReplies(); });
    act(() => { pushSuggestedReplies(["다음 단계"]); });
    expect(result.current.isDismissed).toBe(false);
    expect(result.current.best).toBe("다음 단계");
  });

  it("accept also releases the dismiss latch", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네"]); });
    act(() => { dismissSuggestedReplies(); });
    act(() => { acceptSuggestedReply("네", "best"); });
    act(() => { pushSuggestedReplies(["다음 단계"]); });
    expect(result.current.isDismissed).toBe(false);
  });

  it("multiple subscribers see the same snapshot", () => {
    const { result: r1 } = renderHook(() => useSuggestedReplies());
    const { result: r2 } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네", "아니오"]); });
    expect(r1.current.best).toBe("네");
    expect(r2.current.best).toBe("네");
    expect(r1.current).toBe(r2.current); // identical reference
  });

  // --- PR-D additions: slash filter + telemetry ---

  it("slash-command prefixed suggestions are filtered out", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["/admin", "/clear", "확인"]); });
    expect(result.current.best).toBe("확인");
    expect(result.current.alternates).toEqual([]);
  });

  it("bang and dollar prefixed suggestions are filtered out", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["!run", "$env", "다음"]); });
    expect(result.current.best).toBe("다음");
  });

  it("list with only command-prefixed suggestions collapses to empty", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["/help", "!ls", "$path"]); });
    expect(result.current.best).toBeNull();
    expect(result.current.alternates).toEqual([]);
  });

  it("slash prefix with leading whitespace is also filtered (trim before match)", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["  /admin", "확인"]); });
    expect(result.current.best).toBe("확인");
  });

  it("telemetry: shown counter increments on non-empty push", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네"]); });
    expect(getSuggestedRepliesCounters().shown).toBe(1);
  });

  it("telemetry: dismissed counter increments on dismiss", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네"]); });
    act(() => { dismissSuggestedReplies(); });
    expect(getSuggestedRepliesCounters().dismissed).toBe(1);
  });

  it("telemetry: accepted-best counter increments on best accept", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네"]); });
    act(() => { acceptSuggestedReply("네", "best"); });
    expect(getSuggestedRepliesCounters()["accepted-best"]).toBe(1);
    expect(getSuggestedRepliesCounters()["accepted-chip"]).toBe(0);
  });

  it("telemetry: accepted-chip counter increments on chip accept", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네", "아니오"]); });
    act(() => { acceptSuggestedReply("아니오", "chip"); });
    expect(getSuggestedRepliesCounters()["accepted-chip"]).toBe(1);
    expect(getSuggestedRepliesCounters()["accepted-best"]).toBe(0);
  });

  it("telemetry: ignored counter increments when prior active push is replaced", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["첫 번째"]); });
    act(() => { pushSuggestedReplies(["두 번째"]); });
    expect(getSuggestedRepliesCounters().ignored).toBe(1);
  });

  it("telemetry: dismissed snapshot is NOT counted as ignored on next push", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["첫"]); });
    act(() => { dismissSuggestedReplies(); });
    act(() => { clearDismissedReplies(); });
    act(() => { pushSuggestedReplies(["둘"]); });
    expect(getSuggestedRepliesCounters().ignored).toBe(0);
    expect(getSuggestedRepliesCounters().dismissed).toBe(1);
  });

  it("telemetry: shown is NOT counted when push lands while dismiss latch is set", () => {
    renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["첫"]); }); // shown=1
    act(() => { dismissSuggestedReplies(); });    // dismissed=1, latch on
    act(() => { pushSuggestedReplies(["둘"]); }); // dismissed snapshot, NOT shown
    expect(getSuggestedRepliesCounters().shown).toBe(1);
  });
});
