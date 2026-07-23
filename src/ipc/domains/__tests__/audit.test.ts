import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

import { invokeRegisteredHandlerWithEvent } from "../../../__tests__/test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const { getDlpStats } = vi.hoisted(() => ({
  getDlpStats: vi.fn(async (days: number) => ({ days, totalHits: 0 })),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock("../../../audit/dlp-stats.js", () => ({ getDlpStats }));

import { CHANNELS } from "../../../contract/app-contract.js";
import { registerAuditHandlers } from "../audit.js";
import type { IpcDeps } from "../../types.js";

const HOST_EVENT = {
  senderFrame: { url: "file:///Applications/LVIS.app/dist/src/index.html" },
} as unknown as IpcMainInvokeEvent;
const PLUGIN_EVENT = {
  senderFrame: { url: "file:///Applications/LVIS.app/dist/src/plugin-ui-shell.html" },
} as unknown as IpcMainInvokeEvent;
const REMOTE_EVENT = {
  senderFrame: { url: "https://evil.example.com/" },
} as unknown as IpcMainInvokeEvent;
const MISSING_EVENT = {} as IpcMainInvokeEvent;

const search = vi.fn(async (filter: unknown) => ({ entries: [], total: 0, filter }));
const getStats = vi.fn(async (days: number) => ({ days }));
const flush = vi.fn(async () => undefined);
const log = vi.fn();

function invoke(channel: string, event: IpcMainInvokeEvent, input?: unknown): Promise<unknown> {
  return Promise.resolve(invokeRegisteredHandlerWithEvent(handlers, channel, event, input));
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  registerAuditHandlers({
    auditLogger: { search, getStats, flush, log },
    getMainWindow: () => null,
  } as unknown as IpcDeps);
});

describe("audit IPC sender boundary", () => {
  it.each([PLUGIN_EVENT, REMOTE_EVENT, MISSING_EVENT])(
    "rejects non-host frames on every audit channel",
    async (event) => {
      for (const channel of [CHANNELS.audit.search, CHANNELS.audit.stats, CHANNELS.dlp.stats]) {
        await expect(invoke(channel, event, channel === CHANNELS.audit.search ? {} : 7))
          .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
      }
      expect(search).not.toHaveBeenCalled();
      expect(getStats).not.toHaveBeenCalled();
      expect(getDlpStats).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(3);
    },
  );

  it("allows the packaged host renderer", async () => {
    await invoke(CHANNELS.audit.search, HOST_EVENT, {});
    await invoke(CHANNELS.audit.stats, HOST_EVENT, 30);
    await invoke(CHANNELS.dlp.stats, HOST_EVENT, 14);
    expect(search).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    expect(getStats).toHaveBeenCalledWith(30);
    expect(getDlpStats).toHaveBeenCalledWith(14);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      getDlpStats.mock.invocationCallOrder[0],
    );
  });
});

describe("audit IPC input bounds", () => {
  it("passes a strict, bounded search filter", async () => {
    await invoke(CHANNELS.audit.search, HOST_EVENT, {
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      type: "tool_call",
      textSearch: "needle",
      limit: 25,
      offset: 50,
    });
    expect(search).toHaveBeenCalledWith({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      type: "tool_call",
      textSearch: "needle",
      limit: 25,
      offset: 50,
    });
  });

  it.each([
    null,
    [],
    { unknown: true },
    { dateFrom: "2026-02-30" },
    { dateFrom: "2026-02-02", dateTo: "2026-02-01" },
    { type: "BAD TYPE" },
    { type: "x".repeat(65) },
    { textSearch: "x".repeat(513) },
    { limit: Number.NaN },
    { limit: Number.POSITIVE_INFINITY },
    { limit: 0 },
    { limit: 1.5 },
    { limit: 501 },
    { offset: -1 },
    { offset: 1_000_001 },
  ])("rejects hostile search input %#", async (input) => {
    await expect(invoke(CHANNELS.audit.search, HOST_EVENT, input)).rejects.toThrow(
      /invalid audit IPC input/,
    );
    expect(search).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 3_661, "7", null])(
    "rejects hostile day window %#",
    async (days) => {
      await expect(invoke(CHANNELS.audit.stats, HOST_EVENT, days)).rejects.toThrow(
        /invalid audit IPC input/,
      );
      await expect(invoke(CHANNELS.dlp.stats, HOST_EVENT, days)).rejects.toThrow(
        /invalid audit IPC input/,
      );
    },
  );
});
