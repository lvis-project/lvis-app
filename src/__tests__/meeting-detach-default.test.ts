/**
 * Tests for the meeting plugin "detach by default" feature.
 *
 * Verifies:
 *   1. "plugin:meeting:meeting-control" passes the ALLOWED_VIEW_KEYS allowlist.
 *   2. WindowManager.openDetachedTab creates a BrowserWindow for the meeting
 *      viewKey and records it in the internal children map.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

// ── fs mock (avoids preload path check on disk) ────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) => p === "/fake/preload.cjs" || actual.existsSync(p),
    readFileSync: () => { throw new Error("no-state"); },
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

// ── Electron mock ──────────────────────────────────────────────────────────

const mockWindowInstances: Array<{
  id: number;
  opts: Record<string, unknown>;
  loadedUrl: string | null;
  events: Map<string, Array<() => void>>;
  isDestroyed: () => boolean;
  destroy: () => void;
  show: () => void;
  setMenu: ReturnType<typeof vi.fn>;
}> = [];

let nextWindowId = 1;

vi.mock("electron", () => {
  const BrowserWindow = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    const id = nextWindowId++;
    const events = new Map<string, Array<() => void>>();
    const instance = {
      id,
      opts,
      destroyed: false,
      loadedUrl: null as string | null,
      events,
      isDestroyed: vi.fn(() => instance.destroyed),
      destroy: vi.fn(() => {
        instance.destroyed = true;
        for (const cb of events.get("closed") ?? []) cb();
      }),
      show: vi.fn(),
      loadURL: vi.fn((url: string) => {
        instance.loadedUrl = url;
        return Promise.resolve();
      }),
      setMenu: vi.fn(),
      on: vi.fn((event: string, cb: () => void) => {
        if (!events.has(event)) events.set(event, []);
        events.get(event)!.push(cb);
      }),
      once: vi.fn((event: string, cb: () => void) => {
        if (!events.has(event)) events.set(event, []);
        events.get(event)!.push(cb);
      }),
    };
    mockWindowInstances.push(instance);
    return instance;
  });
  (BrowserWindow as unknown as { fromWebContents: ReturnType<typeof vi.fn> }).fromWebContents = vi.fn(() => null);

  return {
    BrowserWindow,
    ipcMain: {
      handle: vi.fn(),
    },
    screen: {
      getAllDisplays: vi.fn(() => [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]),
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
  };
});

// ── Module imports (after mock) ────────────────────────────────────────────

import { ALLOWED_VIEW_KEYS, WindowManager } from "../main/window-manager.js";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("meeting:detach-default — ALLOWED_VIEW_KEYS", () => {
  it("accepts the meeting plugin viewKey produced by toViewKey()", () => {
    expect(ALLOWED_VIEW_KEYS.test("plugin:meeting:meeting-control")).toBe(true);
  });
});

describe("meeting:detach-default — WindowManager.openDetachedTab", () => {
  let wm: WindowManager;

  beforeEach(() => {
    mockWindowInstances.length = 0;
    nextWindowId = 1;
    wm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
  });

  it("creates a BrowserWindow for plugin:meeting:meeting-control", () => {
    const viewKey = "plugin:meeting:meeting-control";
    const win = wm.openDetachedTab(viewKey);

    expect(win).toBeDefined();
    expect(mockWindowInstances).toHaveLength(1);
  });

  it("uses the generic default detached canvas for plugin views", () => {
    wm.openDetachedTab("plugin:sample-plugin:work-board");

    expect(mockWindowInstances[0].opts["width"]).toBe(800);
    expect(mockWindowInstances[0].opts["height"]).toBe(600);
  });

  it("enables webviewTag for plugin detached windows", () => {
    wm.openDetachedTab("plugin:meeting:meeting-control");
    const prefs = mockWindowInstances[0].opts["webPreferences"] as Record<string, unknown>;
    expect(prefs["webviewTag"]).toBe(true);
  });

  it("creates plugin detached windows without native chrome or menu", () => {
    wm.openDetachedTab("plugin:meeting:meeting-control");
    const opts = mockWindowInstances[0].opts;

    if (process.platform !== "darwin") {
      expect(opts["frame"]).toBe(false);
    }
    expect(opts["titleBarStyle"]).toBe(process.platform === "darwin" ? "hiddenInset" : "hidden");
    expect(opts["autoHideMenuBar"]).toBe(true);
    expect(mockWindowInstances[0].setMenu).toHaveBeenCalledWith(null);
  });

  it("loads the correct detached URL fragment for the meeting viewKey", () => {
    const viewKey = "plugin:meeting:meeting-control";
    wm.openDetachedTab(viewKey);

    const inst = mockWindowInstances[0];
    expect(inst.loadedUrl).toMatch(/#detached\//);
    expect(inst.loadedUrl).toContain(encodeURIComponent(viewKey));
  });

  it("records the meeting window in the children map (listChildren)", () => {
    const viewKey = "plugin:meeting:meeting-control";
    wm.openDetachedTab(viewKey);

    const listed = wm.listChildren();
    expect(listed).toHaveLength(1);
    expect(listed[0].viewKey).toBe(viewKey);
  });
});
