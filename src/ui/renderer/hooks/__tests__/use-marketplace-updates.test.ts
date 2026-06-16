/**
 * Marketplace update hook regression tests.
 *
 * Plugin update skips are exact-version suppressions. A user skip must hide the
 * visible banner immediately, persist `pluginId -> latestVersion`, and allow a
 * newer plugin version to surface again.
 */
import "../../../../../test/renderer/setup.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMarketplaceUpdates, type PluginUpdateInfo } from "../use-marketplace-updates.js";
import type { AppSettings, LvisApi, SettingsUpdateResult } from "../../types.js";

function marketplaceUpdatesApi(options: {
  settings?: Partial<AppSettings>;
  updateSettings?: (patch: Partial<AppSettings>) => Promise<SettingsUpdateResult>;
} = {}) {
  let handler: ((updates: PluginUpdateInfo[]) => void) | null = null;
  const api = {
    getSettings: vi.fn(async () => options.settings ?? {}),
    updateSettings: vi.fn(
      options.updateSettings ??
        (async (patch: Partial<AppSettings>) =>
          ({ ...(options.settings ?? {}), ...patch }) as SettingsUpdateResult),
    ),
    onMarketplaceUpdatesAvailable: vi.fn((h: (updates: PluginUpdateInfo[]) => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    }),
  };
  return {
    api: api as unknown as LvisApi,
    rawApi: api,
    emit: (updates: PluginUpdateInfo[]) => {
      if (!handler) throw new Error("marketplace updates handler not registered");
      handler(updates);
    },
  };
}

describe("useMarketplaceUpdates", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exposes incoming marketplace updates", async () => {
    const { api, rawApi, emit } = marketplaceUpdatesApi();
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await waitFor(() => expect(rawApi.onMarketplaceUpdatesAvailable).toHaveBeenCalledOnce());
    act(() => {
      emit([update("meeting", "0.5.24")]);
    });

    expect(result.current.updates).toEqual([update("meeting", "0.5.24")]);
  });

  it("skip hides visible updates and persists exact latest versions", async () => {
    const { api, rawApi, emit } = marketplaceUpdatesApi({
      settings: {
        marketplace: { skippedPluginUpdates: { meeting: "0.5.23" } },
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update(" meeting ", " 0.5.24 ")]);
    });

    await act(async () => {
      await result.current.skip();
    });

    expect(result.current.updates).toEqual([]);
    expect(rawApi.updateSettings).toHaveBeenCalledWith({
      marketplace: { skippedPluginUpdates: { meeting: "0.5.24" } },
    });
  });

  it("keeps skip persistence best-effort when settings writes fail", async () => {
    const { api, emit } = marketplaceUpdatesApi({
      updateSettings: async () => {
        throw new Error("settings unavailable");
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update("meeting", "0.5.24")]);
    });

    await expect(
      act(async () => {
        await result.current.skip();
      }),
    ).resolves.toBeUndefined();

    expect(result.current.updates).toEqual([update("meeting", "0.5.24")]);
  });

  it("filters skipped versions but allows newer plugin updates", async () => {
    const { api, emit } = marketplaceUpdatesApi({
      settings: {
        marketplace: { skippedPluginUpdates: { meeting: "0.5.24" } },
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update("meeting", "0.5.24"), update("agent-hub", "1.0.0")]);
    });

    expect(result.current.updates).toEqual([update("agent-hub", "1.0.0")]);

    act(() => {
      emit([update("meeting", "0.5.25")]);
    });

    expect(result.current.updates).toEqual([update("meeting", "0.5.25")]);
  });

  it("normalizes incoming update fields before filtering skipped versions", async () => {
    const { api, emit } = marketplaceUpdatesApi({
      settings: {
        marketplace: { skippedPluginUpdates: { meeting: "0.5.24" } },
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update(" meeting ", " 0.5.24 "), update("meeting", "0.5.25")]);
    });

    expect(result.current.updates).toEqual([update("meeting", "0.5.25")]);
  });

  it("ignores reserved skipped-update keys from settings", async () => {
    const skippedPluginUpdates = Object.create(null) as Record<string, string>;
    skippedPluginUpdates.meeting = "0.5.24";
    defineSkippedSetting(skippedPluginUpdates, "__proto__", "1.0.0");
    defineSkippedSetting(skippedPluginUpdates, "constructor", "1.0.0");
    defineSkippedSetting(skippedPluginUpdates, "prototype", "1.0.0");
    const { api, emit } = marketplaceUpdatesApi({
      settings: {
        marketplace: { skippedPluginUpdates },
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([
        update("meeting", "0.5.24"),
        update("__proto__", "1.0.0"),
        update("constructor", "1.0.0"),
        update("prototype", "1.0.0"),
      ]);
    });

    expect(result.current.updates).toEqual([
      update("__proto__", "1.0.0"),
      update("constructor", "1.0.0"),
      update("prototype", "1.0.0"),
    ]);
  });

  it("does not persist reserved plugin ids when skipping visible updates", async () => {
    const { api, rawApi, emit } = marketplaceUpdatesApi();
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update("__proto__", "1.0.0"), update("meeting", "0.5.24")]);
    });

    await act(async () => {
      await result.current.skip();
    });

    expect(rawApi.updateSettings).toHaveBeenCalledWith({
      marketplace: { skippedPluginUpdates: { meeting: "0.5.24" } },
    });
  });
});

function update(pluginId: string, latestVersion: string): PluginUpdateInfo {
  return {
    pluginId,
    pluginName: `LVIS ${pluginId}`,
    installedVersion: "1.0.0",
    latestVersion,
  };
}

function defineSkippedSetting(
  target: Record<string, string>,
  pluginId: string,
  latestVersion: string,
): void {
  Object.defineProperty(target, pluginId, {
    value: latestVersion,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
