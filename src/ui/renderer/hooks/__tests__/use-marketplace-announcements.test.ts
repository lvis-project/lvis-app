// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useMarketplaceAnnouncements,
  type MarketplaceAnnouncement,
} from "../use-marketplace-announcements.js";
import type { AppSettings, LvisApi } from "../../types.js";

function announcementApi(
  settings: { marketplace?: { dismissedAnnouncementIds?: number[] } } = {},
) {
  let handler: ((a: MarketplaceAnnouncement[]) => void) | null = null;
  const api = {
    onMarketplaceAnnouncements: vi.fn((h: (a: MarketplaceAnnouncement[]) => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    }),
    getSettings: vi.fn(async () => settings as unknown as AppSettings),
    updateSettings: vi.fn(async () => ({ ok: true }) as Awaited<ReturnType<LvisApi["updateSettings"]>>),
  };
  return {
    api: api as unknown as LvisApi,
    rawApi: api,
    emit: (a: MarketplaceAnnouncement[]) => {
      if (!handler) throw new Error("announcement handler not registered");
      handler(a);
    },
  };
}

function announcement(id: number): MarketplaceAnnouncement {
  return {
    id,
    title: `t${id}`,
    body: `b${id}`,
    level: "info",
    createdAt: "2026-06-12T00:00:00Z",
    startsAt: null,
    endsAt: null,
  };
}

describe("useMarketplaceAnnouncements", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes announcements pushed over IPC", async () => {
    const { api, rawApi, emit } = announcementApi();
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    await waitFor(() => {
      expect(rawApi.onMarketplaceAnnouncements).toHaveBeenCalledOnce();
    });

    act(() => emit([announcement(1), announcement(2)]));
    expect(result.current.announcements.map((a) => a.id)).toEqual([1, 2]);
  });

  it("removes a dismissed announcement locally and persists its id", async () => {
    const { api, rawApi, emit } = announcementApi({ marketplace: { dismissedAnnouncementIds: [7] } });
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    act(() => emit([announcement(1), announcement(2)]));

    await act(async () => {
      await result.current.dismiss(1);
    });

    expect(result.current.announcements.map((a) => a.id)).toEqual([2]);
    expect(rawApi.updateSettings).toHaveBeenCalledWith({
      marketplace: { dismissedAnnouncementIds: [1, 7] },
    });
  });

  it("does not re-persist an already-dismissed id", async () => {
    const { api, rawApi, emit } = announcementApi({ marketplace: { dismissedAnnouncementIds: [1] } });
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    act(() => emit([announcement(1)]));

    await act(async () => {
      await result.current.dismiss(1);
    });

    expect(result.current.announcements).toEqual([]);
    expect(rawApi.updateSettings).not.toHaveBeenCalled();
  });

  it("normalizes duplicated persisted ids before comparing and writing", async () => {
    const { api, rawApi, emit } = announcementApi({
      marketplace: { dismissedAnnouncementIds: [7, 1, 7] },
    });
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    act(() => emit([announcement(1)]));

    await act(async () => {
      await result.current.dismiss(1);
    });

    expect(result.current.announcements).toEqual([]);
    expect(rawApi.updateSettings).not.toHaveBeenCalled();
  });

  it("filters corrupted persisted dismissal ids before writing", async () => {
    const { api, rawApi, emit } = announcementApi({
      marketplace: {
        dismissedAnnouncementIds: [
          7,
          Number.NaN,
          1.5,
          Number.MAX_SAFE_INTEGER + 1,
          "3",
          7,
        ] as unknown as number[],
      },
    });
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    act(() => emit([announcement(1)]));

    await act(async () => {
      await result.current.dismiss(1);
    });

    expect(rawApi.updateSettings).toHaveBeenCalledWith({
      marketplace: { dismissedAnnouncementIds: [1, 7] },
    });
  });

  it("treats non-array persisted dismissal ids as empty", async () => {
    const { api, rawApi, emit } = announcementApi({
      marketplace: {
        dismissedAnnouncementIds: { invalid: true } as unknown as number[],
      },
    });
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    act(() => emit([announcement(1)]));

    await act(async () => {
      await result.current.dismiss(1);
    });

    expect(rawApi.updateSettings).toHaveBeenCalledWith({
      marketplace: { dismissedAnnouncementIds: [1] },
    });
  });

  it("preserves concurrent dismissals when settings reads are stale", async () => {
    const { api, rawApi, emit } = announcementApi({
      marketplace: { dismissedAnnouncementIds: [7] },
    });
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    act(() => emit([announcement(1), announcement(2)]));

    await act(async () => {
      await Promise.all([result.current.dismiss(1), result.current.dismiss(2)]);
    });

    expect(result.current.announcements).toEqual([]);
    expect(rawApi.updateSettings).toHaveBeenCalled();
    const lastCall = rawApi.updateSettings.mock.calls.at(-1)?.[0];
    expect(
      [...(lastCall?.marketplace?.dismissedAnnouncementIds ?? [])].sort(),
    ).toEqual([1, 2, 7]);
  });

  it("recovers persistence after a dismiss settings write fails", async () => {
    const { api, rawApi, emit } = announcementApi();
    rawApi.updateSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    act(() => emit([announcement(1), announcement(2)]));

    let failed = false;
    await act(async () => {
      try {
        await result.current.dismiss(1);
      } catch {
        failed = true;
      }
    });
    expect(failed).toBe(true);

    await act(async () => {
      await result.current.dismiss(2);
    });

    expect(result.current.announcements).toEqual([]);
    const lastCall = rawApi.updateSettings.mock.calls.at(-1)?.[0];
    expect(
      [...(lastCall?.marketplace?.dismissedAnnouncementIds ?? [])].sort(),
    ).toEqual([1, 2]);
  });

  it("treats resolved IPC error envelopes as failed dismiss settings writes", async () => {
    const { api, rawApi, emit } = announcementApi();
    rawApi.updateSettings.mockResolvedValueOnce({
      ok: false,
      error: "write-failed",
      message: "settings write failed",
    });
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    act(() => emit([announcement(1), announcement(2)]));

    let failed = false;
    await act(async () => {
      try {
        await result.current.dismiss(1);
      } catch {
        failed = true;
      }
    });
    expect(failed).toBe(true);

    await act(async () => {
      await result.current.dismiss(2);
    });

    expect(result.current.announcements).toEqual([]);
    const lastCall = rawApi.updateSettings.mock.calls.at(-1)?.[0];
    expect(
      [...(lastCall?.marketplace?.dismissedAnnouncementIds ?? [])].sort(),
    ).toEqual([1, 2]);
  });

  it("keeps locally dismissed announcements hidden across host pushes before persistence succeeds", async () => {
    const { api, rawApi, emit } = announcementApi();
    rawApi.updateSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    const { result } = renderHook(() => useMarketplaceAnnouncements(api));

    act(() => emit([announcement(1), announcement(2)]));

    await act(async () => {
      await result.current.dismiss(1).catch(() => {});
    });
    expect(result.current.announcements.map((a) => a.id)).toEqual([2]);

    act(() => emit([announcement(1), announcement(2)]));

    expect(result.current.announcements.map((a) => a.id)).toEqual([2]);
  });

  it("unsubscribes on unmount", async () => {
    const unsubscribe = vi.fn();
    const api = {
      onMarketplaceAnnouncements: vi.fn(() => unsubscribe),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
    } as unknown as LvisApi;
    const { unmount } = renderHook(() => useMarketplaceAnnouncements(api));
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
