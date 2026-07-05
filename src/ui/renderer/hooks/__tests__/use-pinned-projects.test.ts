// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LvisApi } from "../../types.js";
import { usePinnedProjects } from "../use-pinned-projects.js";

const ROOT_A = "C:\\Users\\ikcha\\workspace\\lvis-project\\alpha";
const ROOT_B = "C:\\Users\\ikcha\\workspace\\lvis-project\\beta";

function makeApi(seed?: string[]): { api: LvisApi; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn(async () => ({ ok: true }) as never);
  const api = {
    getSettings: vi.fn(async () => ({ system: { pinnedProjectRoots: seed } }) as never),
    updateSettings: update,
  } as unknown as LvisApi;
  return { api, update };
}

describe("usePinnedProjects", () => {
  it("defaults to no pinned projects before the settings seed lands", () => {
    const { api } = makeApi(undefined);
    const { result } = renderHook(() => usePinnedProjects(api));
    expect(result.current.pinnedProjectRoots).toEqual([]);
    expect(result.current.isProjectPinned(ROOT_A)).toBe(false);
  });

  it("seeds the persisted pinned roots from settings on mount", async () => {
    const { api } = makeApi([ROOT_A]);
    const { result } = renderHook(() => usePinnedProjects(api));
    await waitFor(() => expect(result.current.isProjectPinned(ROOT_A)).toBe(true));
    expect(result.current.isProjectPinned(ROOT_B)).toBe(false);
  });

  it("isProjectPinned is root-equality aware (case/slash-insensitive) and false for undefined", async () => {
    const { api } = makeApi([ROOT_A]);
    const { result } = renderHook(() => usePinnedProjects(api));
    await waitFor(() => expect(result.current.pinnedProjectRoots).toEqual([ROOT_A]));
    expect(result.current.isProjectPinned(ROOT_A.toUpperCase())).toBe(true);
    expect(result.current.isProjectPinned(undefined)).toBe(false);
  });

  it("toggleProjectPin pins an unpinned root and persists the full list", async () => {
    const { api, update } = makeApi([]);
    const { result } = renderHook(() => usePinnedProjects(api));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    act(() => result.current.toggleProjectPin(ROOT_A));

    expect(result.current.isProjectPinned(ROOT_A)).toBe(true);
    expect(update).toHaveBeenCalledWith({ system: { pinnedProjectRoots: [ROOT_A] } });
  });

  it("toggleProjectPin unpins an already-pinned root", async () => {
    const { api, update } = makeApi([ROOT_A, ROOT_B]);
    const { result } = renderHook(() => usePinnedProjects(api));
    await waitFor(() => expect(result.current.isProjectPinned(ROOT_A)).toBe(true));

    act(() => result.current.toggleProjectPin(ROOT_A));

    expect(result.current.isProjectPinned(ROOT_A)).toBe(false);
    expect(result.current.isProjectPinned(ROOT_B)).toBe(true);
    expect(update).toHaveBeenCalledWith({ system: { pinnedProjectRoots: [ROOT_B] } });
  });
});
