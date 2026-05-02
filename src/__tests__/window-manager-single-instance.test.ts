/**
 * Tests for the single-instance detached shell policy (Path A).
 *
 * Verifies:
 *   1. Calling openDetachedTab twice with the same viewKey focuses + returns
 *      the existing window instead of creating a second BrowserWindow.
 *   2. Calling openDetachedTab with a different viewKey navigates the existing
 *      shell via lvis:detached:navigate IPC rather than spawning a new window.
 *   3. After the shell is closed, the next openDetachedTab call spawns a fresh
 *      window normally.
 *   4. listChildren() always reflects the current (live) viewKey.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── fs mock ────────────────────────────────────────────────────────────────

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
  destroyed: boolean;
  focused: boolean;
  title: string;
  loadedUrl: string | null;
  sentMessages: Array<[string, unknown]>;
  events: Map<string, Array<() => void>>;
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
      focused: false,
      title: "",
      loadedUrl: null as string | null,
      sentMessages: [] as Array<[string, unknown]>,
      events,
      isDestroyed: vi.fn(() => instance.destroyed),
      focus: vi.fn(() => { instance.focused = true; }),
      setTitle: vi.fn((t: string) => { instance.title = t; }),
      show: vi.fn(),
      close: vi.fn(() => {
        instance.destroyed = true;
        // Trigger "closed" listeners
        for (const cb of events.get("closed") ?? []) cb();
      }),
      destroy: vi.fn(() => {
        instance.destroyed = true;
        for (const cb of events.get("closed") ?? []) cb();
      }),
      loadURL: vi.fn((url: string) => {
        instance.loadedUrl = url;
        return Promise.resolve();
      }),
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => {
          instance.sentMessages.push([channel, payload]);
        }),
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (!events.has(event)) events.set(event, []);
        events.get(event)!.push(cb);
      }),
      once: vi.fn((event: string, cb: () => void) => {
        if (!events.has(event)) events.set(event, []);
        events.get(event)!.push(cb);
      }),
      getBounds: vi.fn(() => ({ x: 200, y: 200, width: 800, height: 600 })),
    };
    mockWindowInstances.push(instance);
    return instance;
  });
  (BrowserWindow as unknown as { fromWebContents: ReturnType<typeof vi.fn> }).fromWebContents = vi.fn(() => null);

  return {
    BrowserWindow,
    ipcMain: { handle: vi.fn() },
    screen: {
      getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    },
  };
});

import { WindowManager } from "../main/window-manager.js";

// ── Test suite ─────────────────────────────────────────────────────────────

describe("WindowManager — single-instance detached shell", () => {
  let wm: WindowManager;

  beforeEach(() => {
    mockWindowInstances.length = 0;
    nextWindowId = 1;
    wm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
  });

  it("same viewKey: focuses existing window, no second BrowserWindow created", () => {
    const viewKey = "plugin:meeting:meeting-control";
    const w1 = wm.openDetachedTab(viewKey);
    const w2 = wm.openDetachedTab(viewKey);

    expect(w1).toBe(w2);
    expect(mockWindowInstances).toHaveLength(1);
    expect(mockWindowInstances[0].focused).toBe(true);
  });

  it("different viewKey: sends lvis:detached:navigate, no second BrowserWindow created", () => {
    const w1 = wm.openDetachedTab("plugin:meeting:meeting-control");
    const w2 = wm.openDetachedTab("plugin:pageindex:search");

    expect(w1).toBe(w2);
    expect(mockWindowInstances).toHaveLength(1);

    const sent = mockWindowInstances[0].sentMessages;
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe("lvis:detached:navigate");
    expect((sent[0][1] as { viewKey: string }).viewKey).toBe("plugin:pageindex:search");
  });

  it("listChildren reflects updated viewKey after in-place navigation", () => {
    wm.openDetachedTab("plugin:meeting:meeting-control");
    wm.openDetachedTab("plugin:pageindex:search");

    const listed = wm.listChildren();
    expect(listed).toHaveLength(1);
    expect(listed[0].viewKey).toBe("plugin:pageindex:search");
  });

  it("after shell closed, next call spawns a fresh window", () => {
    const w1 = wm.openDetachedTab("plugin:meeting:meeting-control");
    // Simulate window close.
    mockWindowInstances[0].close();

    const w2 = wm.openDetachedTab("plugin:pageindex:search");
    expect(w2).not.toBe(w1);
    expect(mockWindowInstances).toHaveLength(2);
  });

  it("same viewKey repeated: no navigate IPC sent (already on that view)", () => {
    wm.openDetachedTab("plugin:meeting:meeting-control");
    wm.openDetachedTab("plugin:meeting:meeting-control");

    // Should not have sent any navigate messages.
    expect(mockWindowInstances[0].sentMessages).toHaveLength(0);
  });

  it("recreates shell when switching between built-in and plugin views so webviewTag stays scoped", () => {
    const builtIn = wm.openDetachedTab("tasks");
    const builtInPrefs = mockWindowInstances[0].opts["webPreferences"] as Record<string, unknown>;
    expect(builtInPrefs["webviewTag"]).toBe(false);

    const plugin = wm.openDetachedTab("plugin:meeting:meeting-control");
    const pluginPrefs = mockWindowInstances[1].opts["webPreferences"] as Record<string, unknown>;
    expect(plugin).not.toBe(builtIn);
    expect(mockWindowInstances).toHaveLength(2);
    expect(mockWindowInstances[0].destroyed).toBe(true);
    expect(pluginPrefs["webviewTag"]).toBe(true);
  });
});
