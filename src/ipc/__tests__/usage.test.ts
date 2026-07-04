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

function hostRendererEvent(): IpcMainInvokeEvent {
  return { senderFrame: { url: "file:///C:/Users/ikcha/workspace/lvis-project/lvis-app/dist/src/index.html" } } as unknown as IpcMainInvokeEvent;
}

function untrustedEvent(): IpcMainInvokeEvent {
  return { senderFrame: { url: "https://evil.example.com/" } } as unknown as IpcMainInvokeEvent;
}

function pluginShellEvent(): IpcMainInvokeEvent {
  return { senderFrame: { url: "file:///C:/Users/ikcha/workspace/lvis-project/lvis-app/dist/src/plugin-ui-shell.html" } } as unknown as IpcMainInvokeEvent;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const mockAuditLogger = { log: vi.fn(), search: vi.fn(), getStats: vi.fn() };
const mockGenerateText = vi.fn(async () => "AI daily summary");

function makeMinimalDeps() {
  return {
    auditLogger: mockAuditLogger,
    conversationLoop: { generateText: mockGenerateText },
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

describe("lvis:usage:daily-summary", () => {
  it("is registered", () => {
    expect(handlers.has("lvis:usage:daily-summary")).toBe(true);
  });

  it("rejects unauthorized sender", async () => {
    const result = await invoke("lvis:usage:daily-summary", untrustedEvent(), { date: "2026-07-04" });
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("rejects plugin shell frames even though they are local file URLs", async () => {
    const result = await invoke("lvis:usage:daily-summary", pluginShellEvent(), { date: "2026-07-04" });
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("generates a constrained LLM daily summary from insight payload", async () => {
    const result = await invoke("lvis:usage:daily-summary", hostRendererEvent(), {
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
    const result = await invoke("lvis:usage:daily-summary", hostRendererEvent(), {
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
    const result = await invoke("lvis:usage:daily-summary", hostRendererEvent(), { date: "2026-07-04" });

    expect(result).toEqual({ ok: false, error: "LLM provider not configured" });
  });

  it("normalizes malformed payloads instead of rejecting the IPC handler", async () => {
    const result = await invoke("lvis:usage:daily-summary", hostRendererEvent(), undefined) as { ok: boolean; summary?: string };

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
