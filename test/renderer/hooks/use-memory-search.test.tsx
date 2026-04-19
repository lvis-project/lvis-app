/**
 * D5 — use-memory-search hook tests.
 */
import "../setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { makeMockLvisApi } from "../mock-lvis-api.js";
import { useMemorySearch } from "../../../src/ui/renderer/hooks/use-memory-search.js";
import type { LvisApi } from "../../../src/ui/renderer/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("useMemorySearch", () => {
  it("debounce: fires IPC only once after 200 ms idle", async () => {
    vi.useFakeTimers();
    const { api } = makeMockLvisApi();
    const { result } = renderHook(() => useMemorySearch(api as unknown as LvisApi));

    // Rapid keystrokes
    act(() => { result.current.setQuery("a"); });
    act(() => { result.current.setQuery("ab"); });
    act(() => { result.current.setQuery("abc"); });

    // IPC not called yet (debounce still pending)
    expect(api.memorySearchNotes).not.toHaveBeenCalled();

    // Advance past debounce and flush promises
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(api.memorySearchNotes).toHaveBeenCalledTimes(1);
    expect(api.memorySearchNotes).toHaveBeenCalledWith("abc");
  });

  it("aliveRef: does not throw after unmount when promise resolves late", async () => {
    vi.useFakeTimers();
    const { api } = makeMockLvisApi();
    let resolveNotes!: (v: unknown[]) => void;
    api.memorySearchNotes = vi.fn(
      () => new Promise((res) => { resolveNotes = res as (v: unknown[]) => void; }),
    );
    api.memorySearchSessions = vi.fn(async () => []);

    const { result, unmount } = renderHook(() => useMemorySearch(api as unknown as LvisApi));

    act(() => { result.current.setQuery("hello"); });

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    // Unmount before the slow promise resolves
    unmount();

    // Resolving after unmount should not throw
    await act(async () => {
      resolveNotes([{ title: "T", excerpt: "E", updatedAt: new Date().toISOString() }]);
      await Promise.resolve();
    });

    expect(true).toBe(true);
  });
});
