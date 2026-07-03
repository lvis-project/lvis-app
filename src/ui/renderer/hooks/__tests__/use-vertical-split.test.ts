// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LvisApi } from "../../types.js";
import { useVerticalSplit } from "../use-vertical-split.js";

function makeApi(seed?: number): { api: LvisApi; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn(async () => ({ ok: true }) as never);
  const api = {
    getSettings: vi.fn(async () => ({ system: { sidePanelSplitFilePercent: seed } }) as never),
    updateSettings: update,
  } as unknown as LvisApi;
  return { api, update };
}

describe("useVerticalSplit", () => {
  it("defaults to 45 before the settings seed lands", () => {
    const { api } = makeApi(undefined);
    const { result } = renderHook(() => useVerticalSplit(api, "sidePanelSplitFilePercent"));
    expect(result.current.topPercent).toBe(45);
  });

  it("seeds the persisted percent from settings on mount", async () => {
    const { api } = makeApi(60);
    const { result } = renderHook(() => useVerticalSplit(api, "sidePanelSplitFilePercent"));
    await waitFor(() => expect(result.current.topPercent).toBe(60));
  });

  it("clamps a seeded out-of-range value into the pane range", async () => {
    const { api } = makeApi(5);
    const { result } = renderHook(() => useVerticalSplit(api, "sidePanelSplitFilePercent"));
    await waitFor(() => expect(result.current.topPercent).toBe(22));
  });

  it("setTopPercent updates state only (no IPC) and clamps", () => {
    const { api, update } = makeApi(undefined);
    const { result } = renderHook(() => useVerticalSplit(api, "sidePanelSplitPreviewPercent"));
    act(() => result.current.setTopPercent(95));
    expect(result.current.topPercent).toBe(78); // clamped to MAX
    expect(update).not.toHaveBeenCalled();
  });

  it("commitTopPercent persists once through the settings round-trip, no-op guarded", async () => {
    const { api, update } = makeApi(undefined);
    const { result } = renderHook(() => useVerticalSplit(api, "sidePanelSplitSubagentPercent"));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    act(() => result.current.commitTopPercent(55));
    expect(update).toHaveBeenCalledWith({ system: { sidePanelSplitSubagentPercent: 55 } });
    update.mockClear();
    // Committing the same value again is a no-op.
    act(() => result.current.commitTopPercent(55));
    expect(update).not.toHaveBeenCalled();
  });
});
