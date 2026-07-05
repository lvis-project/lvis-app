/**
 * Diagnostics domain IPC handlers (#1499 E2) — unit tests.
 *   - unauthorized sender → UNAUTHORIZED_FRAME (fail-closed) on all 3 channels
 *   - crash-list → metadata
 *   - logs:tail → redacted recent lines, level filter, clamp
 *   - export → build + save-dialog path (dialog mocked)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invokeRegisteredHandlerWithEvent } from "../../../__tests__/test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const showSaveDialog = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showSaveDialog: (...a: unknown[]) => showSaveDialog(...a) },
  app: { getPath: () => join(process.env.LVIS_HOME ?? tmpdir(), "..", "userData") },
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerDiagnosticsHandlers } from "../diagnostics.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { AuditLogger } from "../../../audit/audit-logger.js";
import type { IpcDeps } from "../../types.js";

let tmp: string;
const REJECT_EVENT = { senderFrame: { url: "https://evil.example.com" } };

function makeDeps(): IpcDeps {
  const auditLogger = new AuditLogger(join(tmp, "audit"));
  return {
    auditLogger,
    settingsService: {
      getAll: () => ({
        llm: { authMode: "manual", provider: "anthropic", streamSmoothing: "none", fallbackChain: [], vendors: {} },
        chat: { autoCompact: true },
        telemetry: { enabled: false },
        diagnostics: { includeCrashDumps: false, logRetentionDays: 7 },
        system: {},
      }),
      get: (k: string) => (k === "diagnostics" ? { includeCrashDumps: false, logRetentionDays: 7 } : {}),
    },
    getMainWindow: () => null,
  } as unknown as IpcDeps;
}

beforeEach(() => {
  handlers.clear();
  showSaveDialog.mockReset();
  tmp = mkdtempSync(join(tmpdir(), "lvis-diag-ipc-"));
  process.env.LVIS_HOME = tmp;
  mkdirSync(join(tmp, "logs"), { recursive: true });
  mkdirSync(join(tmp, "audit"), { recursive: true });
  registerDiagnosticsHandlers(makeDeps());
});

afterEach(() => {
  delete process.env.LVIS_HOME;
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("diagnostics IPC — fail-closed sender guard", () => {
  it("rejects unauthorized frame on export", async () => {
    const r = await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.export, REJECT_EVENT, {});
    expect(r).toEqual({ ok: false, error: "unauthorized-frame" });
  });
  it("rejects unauthorized frame on crash-list", async () => {
    const r = await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.crashList, REJECT_EVENT);
    expect(r).toEqual({ ok: false, error: "unauthorized-frame" });
  });
  it("rejects unauthorized frame on logs:tail", async () => {
    const r = await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.logs.tail, REJECT_EVENT, {});
    expect(r).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("lvis:logs:tail", () => {
  it("returns recent redacted lines", async () => {
    writeFileSync(
      join(tmp, "logs", "lvis-2025-06-01.log"),
      JSON.stringify({ level: 30, msg: "hi from bob@example.com" }) + "\n",
      "utf-8",
    );
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.logs.tail, null, { lines: 50 })) as {
      ok: boolean;
      lines: string[];
    };
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).not.toContain("bob@example.com");
    expect(r.lines.join("\n")).toContain("[REDACTED:EMAIL]");
  });

  it("clamps an absurd line count and never throws on empty", async () => {
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.logs.tail, null, {
      lines: 10_000_000,
    })) as { ok: boolean; lines: string[] };
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.lines)).toBe(true);
  });

  it("filters by level", async () => {
    writeFileSync(
      join(tmp, "logs", "lvis-2025-06-02.log"),
      [
        JSON.stringify({ level: 30, msg: "info line" }),
        JSON.stringify({ level: 50, msg: "error line" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.logs.tail, null, {
      lines: 50,
      level: "error",
    })) as { ok: boolean; lines: string[] };
    expect(r.lines.join("\n")).toContain("error line");
    expect(r.lines.join("\n")).not.toContain("info line");
  });
});

describe("lvis:diagnostics:crash-list", () => {
  it("returns crash-dump metadata", async () => {
    // Handler resolves <userData>/crash-dumps; app.getPath mock points near tmp.
    const crashDir = join(tmp, "..", "userData", "crash-dumps");
    mkdirSync(crashDir, { recursive: true });
    writeFileSync(join(crashDir, "x.dmp"), "y", "utf-8");
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.crashList, null)) as {
      ok: boolean;
      dumps: Array<{ name: string }>;
    };
    expect(r.ok).toBe(true);
    expect(r.dumps.some((d) => d.name === "x.dmp")).toBe(true);
    rmSync(crashDir, { recursive: true, force: true });
  });
});

describe("lvis:diagnostics:export", () => {
  it("canceled save dialog → { ok:false, canceled:true }", async () => {
    showSaveDialog.mockResolvedValue({ canceled: true });
    const r = await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.export, null, {});
    expect(r).toEqual({ ok: false, canceled: true });
  });

  it("writes the bundle to the chosen path", async () => {
    const out = join(tmp, "bundle.zip");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.export, null, {})) as {
      ok: boolean;
      path: string;
      bytes: number;
    };
    expect(r.ok).toBe(true);
    expect(r.path).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);
  });
});
