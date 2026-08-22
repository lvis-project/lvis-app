/**
 * Usage domain IPC handler tests.
 *
 * Verifies that registerUsageHandlers registers expected channels and that
 * sender validation works on guarded handlers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import {
  foreignFrameEvent,
  hostFrameEvent,
  invokeRegisteredHandlerWithEvent,
  pluginShellFrameEvent,
} from "../../__tests__/test-helpers.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

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

// The aggregation prices with the corrections the domain reads per call, so
// every engine call carries a clock and a correction list. The tests care
// about the days/opts argument, not the other two.
const ANY_CLOCK = expect.any(Date);
const NO_OVERRIDES: readonly never[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
  return invokeRegisteredHandlerWithEvent(handlers, channel, event, ...args);
}

function untrustedEvent(): IpcMainInvokeEvent {
  return foreignFrameEvent("https://evil.example.com/");
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const mockAuditLogger = { log: vi.fn(), search: vi.fn(), getStats: vi.fn(), flush: vi.fn(async (): Promise<void> => {}) };
const mockGenerateText = vi.fn(async () => "AI daily summary");
const noCorrections = (key: string) => (key === "llm" ? {} : undefined);
const mockSettingsGet = vi.fn(noCorrections);

function makeMinimalDeps() {
  return {
    auditLogger: mockAuditLogger,
    conversationLoop: { generateText: mockGenerateText },
    getMainWindow: () => null,
    // The domain reads `llm.pricingOverrides` on every usage call.
    settingsService: { get: mockSettingsGet },
    // rest unused by usage domain
  } as unknown as import("../types.js").IpcDeps;
}

beforeEach(async () => {
  handlers.clear();
  vi.clearAllMocks();
  // clearAllMocks drops calls, not implementations — restore the default so a
  // correction installed by one test does not price the next one.
  mockSettingsGet.mockImplementation(noCorrections);
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
    const result = await invoke("lvis:usage:summary", hostFrameEvent(), 30) as { days: number };
    expect(getUsageSummary).toHaveBeenCalledWith(30, ANY_CLOCK, NO_OVERRIDES);
    expect(result.days).toBe(30);
  });

  it("waits for pending audit writes before reading usage", async () => {
    const { getUsageSummary } = await import("../../engine/usage-stats.js");
    let releaseFlush: (() => void) | undefined;
    mockAuditLogger.flush.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFlush = resolve;
    }));

    const pending = invoke("lvis:usage:summary", hostFrameEvent(), 30) as Promise<unknown>;
    await Promise.resolve();
    expect(getUsageSummary).not.toHaveBeenCalled();
    releaseFlush?.();
    await pending;

    expect(mockAuditLogger.flush).toHaveBeenCalledTimes(1);
    expect(getUsageSummary).toHaveBeenCalledWith(30, ANY_CLOCK, NO_OVERRIDES);
  });

  it("defaults to 60 days when no argument", async () => {
    const { getUsageSummary } = await import("../../engine/usage-stats.js");
    await invoke("lvis:usage:summary", hostFrameEvent());
    expect(getUsageSummary).toHaveBeenCalledWith(60, ANY_CLOCK, NO_OVERRIDES);
  });

  it("carries the price corrections stored right now, not the ones at boot", async () => {
    const { getUsageSummary } = await import("../../engine/usage-stats.js");
    const correction = [
      { vendor: "claude", model: "claude-sonnet-4-6", inputPer1M: 2, outputPer1M: 9 },
    ];
    mockSettingsGet.mockImplementation((key: string) =>
      key === "llm" ? { pricingOverrides: correction } : undefined);

    await invoke("lvis:usage:summary", hostFrameEvent(), 30);

    // Registration happened in beforeEach, before this correction existed: a
    // captured value would still be reporting list price here.
    expect(getUsageSummary).toHaveBeenCalledWith(30, ANY_CLOCK, correction);
  });
});

describe("lvis:usage:range", () => {
  it("is registered", () => {
    expect(handlers.has("lvis:usage:range")).toBe(true);
  });

  it("rejects unauthorized sender", async () => {
    const result = await invoke("lvis:usage:range", untrustedEvent(), { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(mockAuditLogger.flush).not.toHaveBeenCalled();
  });

  it("calls getUsageRange with opts on authorized sender", async () => {
    const { getUsageRange } = await import("../../engine/usage-stats.js");
    const opts = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };
    await invoke("lvis:usage:range", hostFrameEvent(), opts);
    expect(mockAuditLogger.flush).toHaveBeenCalledTimes(1);
    expect(getUsageRange).toHaveBeenCalledWith(opts, ANY_CLOCK, NO_OVERRIDES);
  });
});

describe("lvis:usage:daily-summary", () => {
  it("is registered", () => {
    expect(handlers.has("lvis:usage:daily-summary")).toBe(true);
  });

  it("rejects unauthorized sender", async () => {
    const result = await invoke("lvis:usage:daily-summary", untrustedEvent(), { date: "2026-07-04" });
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(mockAuditLogger.flush).not.toHaveBeenCalled();
  });

  it("rejects plugin shell frames even though they are local file URLs", async () => {
    const result = await invoke("lvis:usage:daily-summary", pluginShellFrameEvent(), { date: "2026-07-04" });
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("generates a constrained LLM daily summary from insight payload", async () => {
    const result = await invoke("lvis:usage:daily-summary", hostFrameEvent(), {
      date: "2026-07-04",
      locale: "ko-KR",
      sessions: [{ title: "프로젝트 작업" }],
      starred: [{ role: "assistant", text: "중요한 결정" }],
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0.001 },
    }) as { ok: boolean; summary?: string };

    expect(result).toMatchObject({ ok: true, summary: "AI daily summary" });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.stringContaining("\"date\":\"2026-07-04\""),
      expect.stringContaining("LVIS Insights"),
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.stringContaining("\"totalTokens\":120"),
      expect.any(String),
    );
  });

  it("redacts sensitive renderer text before sending the daily summary prompt to the LLM", async () => {
    const result = await invoke("lvis:usage:daily-summary", hostFrameEvent(), {
      date: "2026-07-04",
      locale: "ko-KR",
      sessions: [{ title: "Call foo.bar@example.com", projectName: "010-1234-5678 launch" }],
      starred: [{ role: "assistant", text: "Card 4111 1111 1111 1111 was pasted" }],
      usage: { totalTokens: 120 },
    }) as { ok: boolean };

    expect(result.ok).toBe(true);
    const prompt = mockGenerateText.mock.calls.at(-1)?.[0] as string;
    expect(prompt).not.toContain("foo.bar@example.com");
    expect(prompt).not.toContain("010-1234-5678");
    expect(prompt).not.toContain("4111 1111 1111 1111");
    expect(prompt).toContain("[REDACTED:EMAIL]");
    expect(prompt).toContain("[REDACTED:PHONE]");
    expect(prompt).toContain("[REDACTED:CC]");
  });

  it("returns a fail-closed result when the LLM summary call fails", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("LLM provider not configured"));
    const result = await invoke("lvis:usage:daily-summary", hostFrameEvent(), { date: "2026-07-04" });

    expect(result).toEqual({ ok: false, error: "LLM provider not configured" });
  });

  it("normalizes malformed payloads instead of rejecting the IPC handler", async () => {
    const result = await invoke("lvis:usage:daily-summary", hostFrameEvent(), undefined) as { ok: boolean; summary?: string };

    expect(result).toMatchObject({ ok: true, summary: "AI daily summary" });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.stringContaining("\"date\":\"unknown\""),
      expect.any(String),
    );
  });
});

describe("lvis:usage:export-csv", () => {
  it("is registered", () => {
    expect(handlers.has("lvis:usage:export-csv")).toBe(true);
  });

  it("rejects unauthorized sender", async () => {
    const result = await invoke("lvis:usage:export-csv", untrustedEvent(), []);
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(mockAuditLogger.flush).not.toHaveBeenCalled();
  });

  it("returns { ok: false, canceled: true } when dialog is canceled", async () => {
    const result = await invoke("lvis:usage:export-csv", hostFrameEvent(), []) as { ok: boolean; canceled?: boolean };
    expect(result.ok).toBe(false);
    expect(result.canceled).toBe(true);
  });

  it("writes unknownCostTurns to successful CSV exports", async () => {
    const { dialog } = await import("electron");
    const root = mkdtempSync(join(tmpdir(), "lvis-usage-csv-"));
    try {
      const filePath = join(root, "usage.csv");
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath });

      const result = await invoke("lvis:usage:export-csv", hostFrameEvent(), [
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
    } finally {
      await cleanupTmpDir(root);
    }
  });
});
