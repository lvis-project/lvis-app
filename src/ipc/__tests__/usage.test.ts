/**
 * Usage domain IPC handler tests.
 *
 * Verifies that registerUsageHandlers registers expected channels and that
 * sender validation works on guarded handlers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { invokeRegisteredHandlerWithEvent } from "../../__tests__/test-helpers.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mock electron ────────────────────────────────────────────────────────────

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
}));

// ─── Mock usage-stats ─────────────────────────────────────────────────────────

vi.mock("../../engine/usage-stats.js", () => ({
  getUsageSummary: vi.fn(async (days: number) => ({ days, total: 0 })),
  getUsageRange: vi.fn(async (opts: unknown) => ({ range: opts, rows: [] })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
  return invokeRegisteredHandlerWithEvent(handlers, channel, event, ...args);
}

function trustedEvent(): IpcMainInvokeEvent {
  return null as unknown as IpcMainInvokeEvent; // null = trusted (test ergonomics)
}

function untrustedEvent(): IpcMainInvokeEvent {
  return { senderFrame: { url: "https://evil.example.com/" } } as unknown as IpcMainInvokeEvent;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const mockAuditLogger = { log: vi.fn(), search: vi.fn(), getStats: vi.fn() };

function makeMinimalDeps() {
  return {
    auditLogger: mockAuditLogger,
    getMainWindow: () => null,
    // rest unused by usage domain
  } as unknown as import("../types.js").IpcDeps;
}

beforeEach(async () => {
  handlers.clear();
  vi.clearAllMocks();
  const { registerUsageHandlers } = await import("../domains/usage.js");
  registerUsageHandlers(makeMinimalDeps());
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("lvis:usage:summary", () => {
  it("is registered", () => {
    expect(handlers.has("lvis:usage:summary")).toBe(true);
  });

  it("calls getUsageSummary with provided days", async () => {
    const { getUsageSummary } = await import("../../engine/usage-stats.js");
    const result = await invoke("lvis:usage:summary", trustedEvent(), 30) as { days: number };
    expect(getUsageSummary).toHaveBeenCalledWith(30);
    expect(result.days).toBe(30);
  });

  it("defaults to 60 days when no argument", async () => {
    const { getUsageSummary } = await import("../../engine/usage-stats.js");
    await invoke("lvis:usage:summary", trustedEvent());
    expect(getUsageSummary).toHaveBeenCalledWith(60);
  });
});

describe("lvis:usage:range", () => {
  it("is registered", () => {
    expect(handlers.has("lvis:usage:range")).toBe(true);
  });

  it("rejects unauthorized sender", async () => {
    const result = await invoke("lvis:usage:range", untrustedEvent(), { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("calls getUsageRange with opts on authorized sender", async () => {
    const { getUsageRange } = await import("../../engine/usage-stats.js");
    const opts = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };
    await invoke("lvis:usage:range", trustedEvent(), opts);
    expect(getUsageRange).toHaveBeenCalledWith(opts);
  });
});

describe("lvis:usage:export-csv", () => {
  it("is registered", () => {
    expect(handlers.has("lvis:usage:export-csv")).toBe(true);
  });

  it("rejects unauthorized sender", async () => {
    const result = await invoke("lvis:usage:export-csv", untrustedEvent(), []);
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("returns { ok: false, canceled: true } when dialog is canceled", async () => {
    const result = await invoke("lvis:usage:export-csv", trustedEvent(), []) as { ok: boolean; canceled?: boolean };
    expect(result.ok).toBe(false);
    expect(result.canceled).toBe(true);
  });

  it("writes unknownCostTurns to successful CSV exports", async () => {
    const { dialog } = await import("electron");
    const filePath = join(mkdtempSync(join(tmpdir(), "lvis-usage-csv-")), "usage.csv");
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath });

    const result = await invoke("lvis:usage:export-csv", trustedEvent(), [
      {
        date: "2026-05-22",
        vendor: "openai",
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        totalTokens: 110,
        cost: 0,
        unknownCostTurns: 1,
      },
    ]) as { ok: boolean; filePath?: string };

    expect(result).toEqual({ ok: true, filePath });
    const csv = readFileSync(filePath, "utf-8");
    expect(csv.split("\n")[0]).toBe("date,vendor,model,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens,cost,unknownCostTurns");
    expect(csv).toContain('"gpt-4o"');
    expect(csv).toContain(",20,5,");
    expect(csv).toContain(",1");
  });
});
