/**
 * Security regression tests for WindowManager IPC handlers.
 *
 * Guards:
 *   1. validateSender — unauthorized sender → UNAUTHORIZED_FRAME + auditLogger call
 *   2. viewKey allowlist — path-traversal / invalid keys → invalid-view-key error
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

// ── Electron mock ──────────────────────────────────────────────────────────

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      handleMap.set(channel, fn);
    }),
  },
  screen: {
    getAllDisplays: vi.fn(() => []),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
  },
}));

// ── Module imports (after mock) ────────────────────────────────────────────

import { ALLOWED_VIEW_KEYS } from "../main/window-manager.js";
import { UNAUTHORIZED_FRAME } from "../ipc-bridge.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build an event with an unauthorized (remote) sender frame. */
function unauthorizedEvent(): IpcMainInvokeEvent {
  return {
    senderFrame: { url: "https://evil.example.com/pwn" },
    sender: {},
  } as unknown as IpcMainInvokeEvent;
}

/** Build an event with a trusted file:// sender frame. */
function trustedEvent(): IpcMainInvokeEvent {
  return {
    senderFrame: { url: "file:///Applications/Lvis.app/dist/index.html" },
    sender: {},
  } as unknown as IpcMainInvokeEvent;
}

/** Minimal AuditLogger mock. */
function makeAuditLogger() {
  return { log: vi.fn() };
}

// ── ALLOWED_VIEW_KEYS regex ────────────────────────────────────────────────

describe("ALLOWED_VIEW_KEYS", () => {
  it("accepts built-in view keys", () => {
    for (const key of ["tasks", "reminders", "routines", "memory", "starred"]) {
      expect(ALLOWED_VIEW_KEYS.test(key)).toBe(true);
    }
  });

  it("accepts valid plugin view keys (pluginId:extensionId format)", () => {
    // toViewKey() produces plugin:<pluginId>:<extensionId>
    expect(ALLOWED_VIEW_KEYS.test("plugin:meeting:meeting-control")).toBe(true);
    expect(ALLOWED_VIEW_KEYS.test("plugin:my-plugin:main-view")).toBe(true);
    expect(ALLOWED_VIEW_KEYS.test("plugin:my_plugin.v2:panel_a")).toBe(true);
  });

  it("rejects single-segment plugin keys (missing extensionId)", () => {
    expect(ALLOWED_VIEW_KEYS.test("plugin:my-plugin")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("plugin:meeting")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(ALLOWED_VIEW_KEYS.test("../etc/passwd")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("../../etc/shadow")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("plugin:../evil")).toBe(false);
  });

  it("rejects arbitrary strings", () => {
    expect(ALLOWED_VIEW_KEYS.test("unknown-view")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("TASKS")).toBe(false);
  });
});

// ── IPC handler security ───────────────────────────────────────────────────

describe("WindowManager IPC — validateSender guard", () => {
  let WindowManager: typeof import("../main/window-manager.js").WindowManager;
  let auditLogger: ReturnType<typeof makeAuditLogger>;

  beforeEach(async () => {
    handleMap.clear();
    vi.resetModules();
    // Re-import so handleMap gets freshly registered handlers
    const mod = await import("../main/window-manager.js?t=" + Date.now());
    WindowManager = mod.WindowManager;
    auditLogger = makeAuditLogger();
    const wm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
    wm.registerIpc(auditLogger as never);
  });

  describe("lvis:window:open-detached", () => {
    it("returns UNAUTHORIZED_FRAME and calls auditLogger for unauthorized sender", async () => {
      const handler = handleMap.get("lvis:window:open-detached")!;
      const result = await handler(unauthorizedEvent(), "tasks");
      expect(result).toEqual(UNAUTHORIZED_FRAME);
      expect(auditLogger.log).toHaveBeenCalledOnce();
    });

    it("returns invalid-view-key for path traversal viewKey", async () => {
      const handler = handleMap.get("lvis:window:open-detached")!;
      const result = await handler(trustedEvent(), "../etc/passwd");
      expect(result).toEqual({ ok: false, error: "invalid-view-key" });
    });

    it("returns invalid-view-key for empty viewKey", async () => {
      const handler = handleMap.get("lvis:window:open-detached")!;
      const result = await handler(trustedEvent(), "");
      expect(result).toEqual({ ok: false, error: "invalid-view-key" });
    });
  });

  describe("lvis:window:close-detached", () => {
    it("returns UNAUTHORIZED_FRAME and calls auditLogger for unauthorized sender", async () => {
      const handler = handleMap.get("lvis:window:close-detached")!;
      const result = await handler(unauthorizedEvent());
      expect(result).toEqual(UNAUTHORIZED_FRAME);
      expect(auditLogger.log).toHaveBeenCalledOnce();
    });
  });

  describe("lvis:window:list-detached", () => {
    it("returns UNAUTHORIZED_FRAME and calls auditLogger for unauthorized sender", async () => {
      const handler = handleMap.get("lvis:window:list-detached")!;
      const result = await handler(unauthorizedEvent());
      expect(result).toEqual(UNAUTHORIZED_FRAME);
      expect(auditLogger.log).toHaveBeenCalledOnce();
    });
  });
});
