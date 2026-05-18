// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSuggestedReplies,
  pushSuggestedReplies,
  dismissSuggestedReplies,
  acceptSuggestedReply,
  __resetSuggestedRepliesStoreForTests,
  __teardownSuggestedRepliesIpcForTests,
} from "../use-suggested-replies.js";

describe("useSuggestedReplies", () => {
  beforeEach(() => {
    __resetSuggestedRepliesStoreForTests();
    __teardownSuggestedRepliesIpcForTests();
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

  it("new push after dismiss re-enables (fresh snapshot)", () => {
    const { result } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네"]); });
    act(() => { dismissSuggestedReplies(); });
    expect(result.current.isDismissed).toBe(true);
    act(() => { pushSuggestedReplies(["다음 단계"]); });
    expect(result.current.isDismissed).toBe(false);
    expect(result.current.best).toBe("다음 단계");
  });

  it("multiple subscribers see the same snapshot", () => {
    const { result: r1 } = renderHook(() => useSuggestedReplies());
    const { result: r2 } = renderHook(() => useSuggestedReplies());
    act(() => { pushSuggestedReplies(["네", "아니오"]); });
    expect(r1.current.best).toBe("네");
    expect(r2.current.best).toBe("네");
    expect(r1.current).toBe(r2.current); // identical reference
  });
});
