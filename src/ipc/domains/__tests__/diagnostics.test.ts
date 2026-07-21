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
import { fixtureSecret } from "../../../audit/__tests__/secret-fixtures.js";

let tmp: string;
const REJECT_EVENT = { senderFrame: { url: "https://evil.example.com" } };
// A plugin UI shell is a file:// frame (so it passes the base validateSender)
// but must be rejected by validateHostRendererSender at these host channels.
const PLUGIN_SHELL_EVENT = {
  senderFrame: { url: "file:///C:/app/resources/plugin-ui-shell.html" },
};
// A trusted host renderer frame — validateHostRendererSender accepts a file://
// frame that is NOT the plugin-ui-shell. Note: unlike the base validateSender,
// this guard fails closed on a null/empty frame URL, so the happy-path tests
// MUST supply a concrete host frame (they previously passed `null`).
const ACCEPT_EVENT = { senderFrame: { url: "file:///C:/app/resources/index.html" } };

function makeDeps(overrides?: { includeCrashDumps?: boolean }): IpcDeps {
  const auditLogger = new AuditLogger(join(tmp, "audit"));
  const diagnostics = {
    includeCrashDumps: overrides?.includeCrashDumps ?? false,
    logRetentionDays: 7,
  };
  return {
    auditLogger,
    settingsService: {
      getAll: () => ({
        llm: { provider: "anthropic", streamSmoothing: "none", fallbackChain: [], vendors: {} },
        chat: { autoCompact: true },
        telemetry: { enabled: false },
        diagnostics,
        system: {},
      }),
      get: (k: string) => (k === "diagnostics" ? diagnostics : {}),
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

  it("rejects a plugin-ui-shell frame on all 3 channels (m1: validateHostRendererSender)", async () => {
    const exp = await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.export, PLUGIN_SHELL_EVENT, {});
    const crash = await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.crashList, PLUGIN_SHELL_EVENT);
    const tail = await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.logs.tail, PLUGIN_SHELL_EVENT, {});
    expect(exp).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(crash).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(tail).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("lvis:logs:tail", () => {
  it("returns recent redacted lines", async () => {
    writeFileSync(
      join(tmp, "logs", "lvis-2025-06-01.log"),
      JSON.stringify({ level: 30, msg: "hi from bob@example.com" }) + "\n",
      "utf-8",
    );
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.logs.tail, ACCEPT_EVENT, { lines: 50 })) as {
      ok: boolean;
      lines: string[];
    };
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).not.toContain("bob@example.com");
    expect(r.lines.join("\n")).toContain("[REDACTED:EMAIL]");
  });

  it("redacts credential-class secrets in recent log lines", async () => {
    const githubPat = fixtureSecret("github", "_pat_", "1234567890abcdefghijklmnopqrstuv_1234567890");
    const awsSecret = fixtureSecret("wJalrXUtn", "FEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    writeFileSync(
      join(tmp, "logs", "lvis-2025-06-01.log"),
      [
        JSON.stringify({ level: 30, msg: `github ${githubPat}` }),
        JSON.stringify({ level: 30, msg: `AWS_SECRET_ACCESS_KEY=${awsSecret}` }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.logs.tail, ACCEPT_EVENT, { lines: 50 })) as {
      ok: boolean;
      lines: string[];
    };
    const text = r.lines.join("\n");

    expect(r.ok).toBe(true);
    expect(text).not.toContain(githubPat);
    expect(text).not.toContain(awsSecret);
    expect(text).toContain("[REDACTED:TOKEN]");
  });

  it("clamps an absurd line count and never throws on empty", async () => {
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.logs.tail, ACCEPT_EVENT, {
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
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.logs.tail, ACCEPT_EVENT, {
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
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.crashList, ACCEPT_EVENT)) as {
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
    const r = await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.export, ACCEPT_EVENT, {});
    expect(r).toEqual({ ok: false, canceled: true });
  });

  it("writes the bundle to the chosen path", async () => {
    const out = join(tmp, "bundle.zip");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });
    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.export, ACCEPT_EVENT, {})) as {
      ok: boolean;
      path: string;
      bytes: number;
    };
    expect(r.ok).toBe(true);
    expect(r.path).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it("persisted setting false + renderer arg true → crash-dump binary NOT included (M2)", async () => {
    // The persisted setting is authoritative; a renderer that sends
    // includeCrashDumps:true can never widen past the disabled setting.
    handlers.clear();
    registerDiagnosticsHandlers(makeDeps({ includeCrashDumps: false }));
    const crashDir = join(tmp, "..", "userData", "crash-dumps");
    mkdirSync(crashDir, { recursive: true });
    writeFileSync(join(crashDir, "boom.dmp"), "RAWCRASHBINARYSECRET", "utf-8");
    const out = join(tmp, "bundle-m2.zip");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });

    const r = (await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.export, ACCEPT_EVENT, {
      includeCrashDumps: true,
    })) as { ok: boolean };
    expect(r.ok).toBe(true);

    const { readFileSync } = await import("node:fs");
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(readFileSync(out));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).not.toContain("crash-dumps/boom.dmp");
    const allText = zip.getEntries().map((e) => e.getData().toString("utf-8")).join("\n");
    expect(allText).not.toContain("RAWCRASHBINARYSECRET");
    rmSync(crashDir, { recursive: true, force: true });
  });

  it("persisted setting true + renderer opts out → crash-dump binary NOT included (M2 narrows)", async () => {
    handlers.clear();
    registerDiagnosticsHandlers(makeDeps({ includeCrashDumps: true }));
    const crashDir = join(tmp, "..", "userData", "crash-dumps");
    mkdirSync(crashDir, { recursive: true });
    writeFileSync(join(crashDir, "boom.dmp"), "RAWCRASHBINARYSECRET", "utf-8");
    const out = join(tmp, "bundle-narrow.zip");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });

    await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.export, ACCEPT_EVENT, {
      includeCrashDumps: false,
    });
    const { readFileSync } = await import("node:fs");
    const AdmZip = (await import("adm-zip")).default;
    const names = new AdmZip(readFileSync(out)).getEntries().map((e) => e.entryName);
    expect(names).not.toContain("crash-dumps/boom.dmp");
    rmSync(crashDir, { recursive: true, force: true });
  });

  it("emits a diagnostics-export audit row on success (m2 forensics)", async () => {
    const out = join(tmp, "bundle-audit.zip");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: out });
    await invokeRegisteredHandlerWithEvent(handlers, CHANNELS.diagnostics.export, ACCEPT_EVENT, {
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
    });
    const logger = new AuditLogger(join(tmp, "audit"));
    const { entries } = await logger.search({ dateFrom: "2000-01-01", dateTo: "2099-01-01", limit: 1000, offset: 0 });
    const exportRow = entries.find((e) => e.type === "diagnostics-export");
    expect(exportRow).toBeDefined();
    const payload = JSON.parse(exportRow!.input ?? "{}");
    expect(payload.includeCrashDumps).toBe(false);
    expect(payload.bytes).toBeGreaterThan(0);
    // Destination path is recorded (redacted) for forensics.
    expect(typeof payload.path).toBe("string");
  });
});
