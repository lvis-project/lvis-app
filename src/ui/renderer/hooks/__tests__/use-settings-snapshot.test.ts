// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSettingsSnapshot, type SettingsSnapshotApi } from "../use-settings-snapshot.js";
import type { AppSettings } from "../../types.js";

type Broadcast = Parameters<SettingsSnapshotApi["onSettingsUpdated"]>[0];

function makeApi(initial: Promise<AppSettings>) {
  let broadcast: Broadcast | null = null;
  const unsubscribe = vi.fn();
  const api: SettingsSnapshotApi = {
    getSettings: vi.fn(() => initial),
    onSettingsUpdated: vi.fn((handler: Broadcast) => {
      broadcast = handler;
      return unsubscribe;
    }),
  };
  return { api, unsubscribe, emit: (s: AppSettings) => broadcast?.(s) };
}

const snapshot = (marker: string) => ({ marketplace: { cloudBaseUrl: marker } }) as unknown as AppSettings;

describe("useSettingsSnapshot", () => {
  it("seeds from getSettings, then follows every broadcast, and unsubscribes on unmount", async () => {
    const { api, unsubscribe, emit } = makeApi(Promise.resolve(snapshot("seed")));
    const apply = vi.fn();
    const { unmount } = renderHook(() => useSettingsSnapshot(api, apply));

    await waitFor(() => expect(apply).toHaveBeenCalledWith(snapshot("seed")));
    expect(api.onSettingsUpdated).toHaveBeenCalledTimes(1);

    act(() => { emit(snapshot("broadcast")); });
    expect(apply).toHaveBeenLastCalledWith(snapshot("broadcast"));

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("drops a seed that resolves after unmount", async () => {
    let resolve!: (s: AppSettings) => void;
    const { api } = makeApi(new Promise<AppSettings>((r) => { resolve = r; }));
    const apply = vi.fn();
    const { unmount } = renderHook(() => useSettingsSnapshot(api, apply));
    unmount();
    await act(async () => { resolve(snapshot("late")); });
    expect(apply).not.toHaveBeenCalled();
  });
});
