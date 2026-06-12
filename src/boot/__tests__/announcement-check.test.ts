/**
 * wireAnnouncementCheck — boot-time marketplace announcement poller.
 *
 * Verifies: it pushes the active set on first run, drops dismissed ids before
 * pushing, dedupes identical pushes, and re-fires when the dismissed set
 * changes (so a dismiss clears the banner without the next identical server
 * response resurrecting it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { wireAnnouncementCheck } from "../steps/post-boot.js";
import type { MarketplaceFetcher } from "../../plugins/marketplace.js";
import type { SettingsService } from "../../data/settings-store.js";
import { MARKETPLACE } from "../../shared/ipc-channels.js";
import type { MarketplaceAnnouncement } from "../../shared/marketplace-announcements.js";

vi.mock("electron", () => ({
  app: { prependOnceListener: vi.fn() },
}));

function announcement(
  id: number,
  patch: Partial<MarketplaceAnnouncement> = {},
): MarketplaceAnnouncement {
  return {
    id,
    title: `t${id}`,
    body: `b${id}`,
    level: "info",
    createdAt: "2026-06-12T00:00:00Z",
    startsAt: null,
    endsAt: null,
    ...patch,
  };
}

function harness(opts: {
  announcements: MarketplaceAnnouncement[];
  dismissed?: number[];
}) {
  const { mainWindow, send } = makeWindow();

  let dismissed = opts.dismissed ?? [];
  const settingsService = {
    get: vi.fn((key: string) =>
      key === "marketplace" ? { dismissedAnnouncementIds: dismissed } : undefined,
    ),
  } as unknown as SettingsService;

  const listAnnouncements = vi.fn(async () => opts.announcements);
  const marketplaceFetcher = { listAnnouncements } as unknown as MarketplaceFetcher;

  return {
    send,
    listAnnouncements,
    setDismissed: (ids: number[]) => {
      dismissed = ids;
    },
    run: () =>
      wireAnnouncementCheck({
        getMainWindow: () => mainWindow,
        settingsService,
        marketplaceFetcher,
      }),
  };
}

function makeWindow(opts: { url?: string; loading?: boolean } = {}) {
  const send = vi.fn();
  let didFinishLoad: (() => void) | null = null;
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      getURL: opts.url === undefined ? undefined : vi.fn(() => opts.url),
      isLoading: opts.loading === undefined ? undefined : vi.fn(() => opts.loading),
      once: opts.url === undefined && opts.loading === undefined
        ? undefined
        : vi.fn((_event: "did-finish-load", listener: () => void) => {
          didFinishLoad = listener;
        }),
      send,
    },
  } as unknown as NonNullable<
    ReturnType<Parameters<typeof wireAnnouncementCheck>[0]["getMainWindow"]>
  >;
  return {
    mainWindow,
    send,
    finishLoad: () => {
      if (!didFinishLoad) throw new Error("did-finish-load listener not registered");
      didFinishLoad();
    },
  };
}

describe("wireAnnouncementCheck", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not poll when marketplace update checks are disabled", async () => {
    const { mainWindow, send } = makeWindow();
    const settingsService = {
      get: vi.fn((key: string) =>
        key === "marketplace"
          ? {
              dismissedAnnouncementIds: [],
              updateCheckEnabled: false,
              updateCheckIntervalMs: 1000,
            }
          : undefined,
      ),
    } as unknown as SettingsService;
    const marketplaceFetcher = {
      listAnnouncements: vi.fn(async () => [announcement(1)]),
    } as unknown as MarketplaceFetcher;

    wireAnnouncementCheck({
      getMainWindow: () => mainWindow,
      settingsService,
      marketplaceFetcher,
    });
    await Promise.resolve();

    expect(marketplaceFetcher.listAnnouncements).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("pushes the active announcement set on first run", async () => {
    const h = harness({ announcements: [announcement(1), announcement(2)] });
    h.run();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    const [channel, payload] = h.send.mock.calls[0];
    expect(channel).toBe(MARKETPLACE.announcements);
    expect((payload as MarketplaceAnnouncement[]).map((a) => a.id)).toEqual([2, 1]);
  });

  it("waits for the renderer load before the first announcement poll", async () => {
    const { mainWindow, send, finishLoad } = makeWindow({
      url: "data:text/html;charset=utf-8,splash",
      loading: false,
    });
    const settingsService = {
      get: vi.fn(() => ({ dismissedAnnouncementIds: [], updateCheckIntervalMs: 1000 })),
    } as unknown as SettingsService;
    const marketplaceFetcher = {
      listAnnouncements: vi.fn(async () => [announcement(1)]),
    } as unknown as MarketplaceFetcher;

    wireAnnouncementCheck({
      getMainWindow: () => mainWindow,
      settingsService,
      marketplaceFetcher,
    });
    await Promise.resolve();

    expect(marketplaceFetcher.listAnnouncements).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    finishLoad();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(marketplaceFetcher.listAnnouncements).toHaveBeenCalledOnce();
  });

  it("filters out dismissed ids before pushing", async () => {
    const h = harness({ announcements: [announcement(1), announcement(2)], dismissed: [1] });
    h.run();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    const payload = h.send.mock.calls[0][1] as MarketplaceAnnouncement[];
    expect(payload.map((a) => a.id)).toEqual([2]);
  });

  it("sorts visible announcements newest first before broadcasting", async () => {
    const h = harness({
      announcements: [
        announcement(1, { createdAt: "2026-06-11T00:00:00Z" }),
        announcement(3, { createdAt: "2026-06-12T00:00:00Z" }),
        announcement(2, { createdAt: "2026-06-12T00:00:00Z" }),
      ],
    });
    h.run();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    const payload = h.send.mock.calls[0][1] as MarketplaceAnnouncement[];
    expect(payload.map((a) => a.id)).toEqual([3, 2, 1]);
  });

  it("dedupes identical interval pushes but re-fires when the dismissed set changes", async () => {
    vi.useFakeTimers();
    try {
      const { mainWindow, send } = makeWindow();

      let dismissed: number[] = [];
      const settingsService = {
        get: vi.fn(() => ({
          dismissedAnnouncementIds: dismissed,
          updateCheckIntervalMs: 1000,
        })),
      } as unknown as SettingsService;
      const marketplaceFetcher = {
        listAnnouncements: vi.fn(async () => [announcement(1), announcement(2)]),
      } as unknown as MarketplaceFetcher;

      wireAnnouncementCheck({
        getMainWindow: () => mainWindow,
        settingsService,
        marketplaceFetcher,
      });
      // Boot run.
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(
        (send.mock.calls[0][1] as MarketplaceAnnouncement[]).map((a) => a.id),
      ).toEqual([2, 1]);

      // Identical interval run → deduped, no new push.
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).toHaveBeenCalledTimes(1);

      // User dismisses id 1 (settings mutates); next interval re-fires with [2].
      dismissed = [1];
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(
        (send.mock.calls[1][1] as MarketplaceAnnouncement[]).map((a) => a.id),
      ).toEqual([2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-fires an identical payload when the main window webContents changes", async () => {
    vi.useFakeTimers();
    try {
      const first = makeWindow();
      const second = makeWindow();
      let mainWindow = first.mainWindow;
      const settingsService = {
        get: vi.fn(() => ({
          dismissedAnnouncementIds: [],
          updateCheckIntervalMs: 1000,
        })),
      } as unknown as SettingsService;
      const marketplaceFetcher = {
        listAnnouncements: vi.fn(async () => [announcement(1)]),
      } as unknown as MarketplaceFetcher;

      wireAnnouncementCheck({
        getMainWindow: () => mainWindow,
        settingsService,
        marketplaceFetcher,
      });
      await vi.waitFor(() => expect(first.send).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(1000);
      expect(first.send).toHaveBeenCalledTimes(1);
      expect(second.send).not.toHaveBeenCalled();

      mainWindow = second.mainWindow;
      await vi.advanceTimersByTimeAsync(1000);

      await vi.waitFor(() => expect(second.send).toHaveBeenCalledTimes(1));
      expect((second.send.mock.calls[0][1] as MarketplaceAnnouncement[]).map((a) => a.id)).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-fires when an announcement payload changes under the same id and createdAt", async () => {
    vi.useFakeTimers();
    try {
      const { mainWindow, send } = makeWindow();
      let announcements = [announcement(1, { body: "before", level: "info" })];
      const settingsService = {
        get: vi.fn(() => ({
          dismissedAnnouncementIds: [],
          updateCheckIntervalMs: 1000,
        })),
      } as unknown as SettingsService;
      const marketplaceFetcher = {
        listAnnouncements: vi.fn(async () => announcements),
      } as unknown as MarketplaceFetcher;

      wireAnnouncementCheck({
        getMainWindow: () => mainWindow,
        settingsService,
        marketplaceFetcher,
      });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

      announcements = [announcement(1, { body: "after", level: "warning" })];
      await vi.advanceTimersByTimeAsync(1000);

      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect((send.mock.calls[1][1] as MarketplaceAnnouncement[])[0]).toMatchObject({
        body: "after",
        level: "warning",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats corrupted dismissed ids in settings as empty", async () => {
    const { mainWindow, send } = makeWindow();
    const settingsService = {
      get: vi.fn(() => ({
        dismissedAnnouncementIds: { invalid: true },
      })),
    } as unknown as SettingsService;
    const marketplaceFetcher = {
      listAnnouncements: vi.fn(async () => [announcement(1)]),
    } as unknown as MarketplaceFetcher;

    wireAnnouncementCheck({
      getMainWindow: () => mainWindow,
      settingsService,
      marketplaceFetcher,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0][1] as MarketplaceAnnouncement[]).map((a) => a.id)).toEqual([1]);
  });

  it("filters invalid dismissed ids from settings before applying them", async () => {
    const { mainWindow, send } = makeWindow();
    const settingsService = {
      get: vi.fn(() => ({
        dismissedAnnouncementIds: [
          1,
          Number.NaN,
          1.5,
          Number.MAX_SAFE_INTEGER + 1,
          "2",
        ],
      })),
    } as unknown as SettingsService;
    const marketplaceFetcher = {
      listAnnouncements: vi.fn(async () => [announcement(1), announcement(2)]),
    } as unknown as MarketplaceFetcher;

    wireAnnouncementCheck({
      getMainWindow: () => mainWindow,
      settingsService,
      marketplaceFetcher,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0][1] as MarketplaceAnnouncement[]).map((a) => a.id)).toEqual([2]);
  });

  it("clears visible announcements once when the marketplace fetch fails", async () => {
    vi.useFakeTimers();
    try {
      const { mainWindow, send } = makeWindow();

      let shouldFail = false;
      const settingsService = {
        get: vi.fn(() => ({
          dismissedAnnouncementIds: [],
          updateCheckIntervalMs: 1000,
        })),
      } as unknown as SettingsService;
      const marketplaceFetcher = {
        listAnnouncements: vi.fn(async () => {
          if (shouldFail) throw new Error("offline");
          return [announcement(1)];
        }),
      } as unknown as MarketplaceFetcher;

      wireAnnouncementCheck({
        getMainWindow: () => mainWindow,
        settingsService,
        marketplaceFetcher,
      });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(
        (send.mock.calls[0][1] as MarketplaceAnnouncement[]).map((a) => a.id),
      ).toEqual([1]);

      shouldFail = true;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls[1]).toEqual([MARKETPLACE.announcements, []]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends interval pushes to the current main window", async () => {
    vi.useFakeTimers();
    try {
      const first = makeWindow();
      const second = makeWindow();
      let currentWindow: typeof first.mainWindow | null = first.mainWindow;
      let announcements = [announcement(1)];
      const settingsService = {
        get: vi.fn(() => ({
          dismissedAnnouncementIds: [],
          updateCheckIntervalMs: 1000,
        })),
      } as unknown as SettingsService;
      const marketplaceFetcher = {
        listAnnouncements: vi.fn(async () => announcements),
      } as unknown as MarketplaceFetcher;

      wireAnnouncementCheck({
        getMainWindow: () => currentWindow,
        settingsService,
        marketplaceFetcher,
      });
      await vi.waitFor(() => expect(first.send).toHaveBeenCalledTimes(1));

      currentWindow = second.mainWindow;
      announcements = [announcement(2)];
      await vi.advanceTimersByTimeAsync(1000);

      await vi.waitFor(() => expect(second.send).toHaveBeenCalledTimes(1));
      expect(first.send).toHaveBeenCalledTimes(1);
      expect(
        (second.send.mock.calls[0][1] as MarketplaceAnnouncement[]).map((a) => a.id),
      ).toEqual([2]);
    } finally {
      vi.useRealTimers();
    }
  });
});
