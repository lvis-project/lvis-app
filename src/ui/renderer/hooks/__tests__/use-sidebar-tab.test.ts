// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LvisApi } from "../../types.js";
import { useSidebarGroups, useSidebarTab } from "../use-sidebar-tab.js";

function makeApi(seed?: unknown): { api: LvisApi; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn(async () => ({ ok: true }) as never);
  const api = {
    getSettings: vi.fn(async () => ({ system: { sidebarActiveTab: seed } }) as never),
    updateSettings: update,
  } as unknown as LvisApi;
  return { api, update };
}

describe("useSidebarTab", () => {
  it("defaults to the chats tab before the settings seed lands", () => {
    const { api } = makeApi(undefined);
    const { result } = renderHook(() => useSidebarTab(api));
    expect(result.current.activeTab).toBe("chats");
  });

  it("seeds the persisted tab from settings on mount", async () => {
    const { api } = makeApi("projects");
    const { result } = renderHook(() => useSidebarTab(api));
    await waitFor(() => expect(result.current.activeTab).toBe("projects"));
  });

  it("ignores an invalid persisted value and keeps the default", async () => {
    const { api } = makeApi("bogus");
    const { result } = renderHook(() => useSidebarTab(api));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    expect(result.current.activeTab).toBe("chats");
  });

  it("setActiveTab updates state and persists through the settings round-trip", async () => {
    const { api, update } = makeApi(undefined);
    const { result } = renderHook(() => useSidebarTab(api));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    // A bare "was getSettings called" check races the mount-seed effect's
    // `.then().finally()` chain (which flips the internal `hydrated` flag a
    // tier later than the raw promise) — yield to a macrotask so every
    // pending microtask in that chain has drained before switching tabs.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => result.current.setActiveTab("projects"));

    expect(result.current.activeTab).toBe("projects");
    expect(update).toHaveBeenCalledWith({ system: { sidebarActiveTab: "projects" } });
  });

  it("does not call updateSettings for a tab switch made before the mount-seed read resolves", async () => {
    let resolveSettings: (value: unknown) => void = () => {};
    const update = vi.fn(async () => ({ ok: true }) as never);
    const api = {
      getSettings: vi.fn(() => new Promise((resolve) => { resolveSettings = resolve; })),
      updateSettings: update,
    } as unknown as LvisApi;

    const { result } = renderHook(() => useSidebarTab(api));
    // Switch tabs before the mount-seed read resolves — state updates
    // immediately, but the guarded write must not race the seed.
    act(() => result.current.setActiveTab("projects"));
    expect(result.current.activeTab).toBe("projects");
    expect(update).not.toHaveBeenCalled();

    resolveSettings({ system: {} });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
  });
});

describe("useSidebarGroups", () => {
  function makeGroupsApi(seed?: unknown): { api: LvisApi; update: ReturnType<typeof vi.fn> } {
    const update = vi.fn(async () => ({ ok: true }) as never);
    const api = {
      getSettings: vi.fn(async () => ({ system: { sidebarClosedGroups: seed } }) as never),
      updateSettings: update,
    } as unknown as LvisApi;
    return { api, update };
  }

  it("opens every group before the settings seed lands", () => {
    const { api } = makeGroupsApi(undefined);
    const { result } = renderHook(() => useSidebarGroups(api));
    expect(result.current.closedGroups.size).toBe(0);
  });

  it("seeds the folded set from settings, dropping unknown groups", async () => {
    const { api } = makeGroupsApi(["plugins", "bogus"]);
    const { result } = renderHook(() => useSidebarGroups(api));
    await waitFor(() => expect(result.current.closedGroups.has("plugins")).toBe(true));
    expect([...result.current.closedGroups]).toEqual(["plugins"]);
  });

  it("setGroupOpen folds and opens a group, persisting the closed list", async () => {
    const { api, update } = makeGroupsApi(undefined);
    const { result } = renderHook(() => useSidebarGroups(api));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => result.current.setGroupOpen("features", false));
    expect(result.current.closedGroups.has("features")).toBe(true);
    expect(update).toHaveBeenLastCalledWith({ system: { sidebarClosedGroups: ["features"] } });

    act(() => result.current.setGroupOpen("features", true));
    expect(result.current.closedGroups.has("features")).toBe(false);
    expect(update).toHaveBeenLastCalledWith({ system: { sidebarClosedGroups: [] } });
  });

  it("does not persist a toggle made before the mount-seed read resolves", async () => {
    let resolveSettings: (value: unknown) => void = () => {};
    const update = vi.fn(async () => ({ ok: true }) as never);
    const api = {
      getSettings: vi.fn(() => new Promise((resolve) => { resolveSettings = resolve; })),
      updateSettings: update,
    } as unknown as LvisApi;

    const { result } = renderHook(() => useSidebarGroups(api));
    act(() => result.current.setGroupOpen("plugins", false));
    expect(result.current.closedGroups.has("plugins")).toBe(true);
    expect(update).not.toHaveBeenCalled();

    resolveSettings({ system: {} });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
  });
});
