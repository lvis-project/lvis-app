/**
 * #885 b2 — WindowManager MCP-app detach surface.
 *
 * Covers:
 *   - ALLOWED_VIEW_KEYS accepts `mcp-app:<hex>:<cardId>` and rejects malformed;
 *   - will-attach-webview allowlist widening (lvis-mcp-app:* + persist:plugin:*
 *     accepted, everything else preventDefault); webviewTag true for mcp-app;
 *   - openDetachedMcpApp mints a host-side cardId + stores the payload; the
 *     detached-payload read returns it;
 *   - closeDetachedMcpWindows closes ONLY the matching server's windows + purges
 *     their payloads;
 *   - the open-detached IPC gates on validateHostRendererSender + validates the
 *     payload (serverId non-empty, resourceUri `ui://`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { ALLOWED_VIEW_KEYS } from "../main/window-manager.js";
import { mcpAppPartitionName, mcpAppViewKey } from "../shared/mcp-app-partition.js";
import type { McpUiPayload } from "../mcp/types.js";

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
type WillAttach = (event: { preventDefault: () => void }, prefs: Record<string, unknown>, params: Record<string, unknown>) => void;

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const mockWindowInstances: Array<{
  id: number;
  opts: Record<string, unknown>;
  destroyed: boolean;
  title: string;
  willAttach: WillAttach | null;
  events: Map<string, Array<() => void>>;
  close: ReturnType<typeof vi.fn>;
}> = [];
let nextWindowId = 1;

vi.mock("electron", () => {
  const BrowserWindow = vi.fn().mockImplementation(function (this: unknown, opts: Record<string, unknown>) {
    const id = nextWindowId++;
    const events = new Map<string, Array<() => void>>();
    const instance = {
      id,
      opts,
      destroyed: false,
      title: "",
      willAttach: null as WillAttach | null,
      events,
      isDestroyed: vi.fn(() => instance.destroyed),
      focus: vi.fn(),
      setTitle: vi.fn((t: string) => { instance.title = t; }),
      setSize: vi.fn(),
      setMinimumSize: vi.fn(),
      setResizable: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      show: vi.fn(),
      close: vi.fn(() => {
        instance.destroyed = true;
        for (const cb of events.get("closed") ?? []) cb();
      }),
      destroy: vi.fn(() => {
        instance.destroyed = true;
        for (const cb of events.get("closed") ?? []) cb();
      }),
      loadURL: vi.fn(() => Promise.resolve()),
      webContents: {
        send: vi.fn(),
        on: vi.fn((event: string, cb: unknown) => {
          if (event === "will-attach-webview") instance.willAttach = cb as WillAttach;
        }),
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (!events.has(event)) events.set(event, []);
        events.get(event)!.push(cb);
      }),
      once: vi.fn(),
      getBounds: vi.fn(() => ({ x: 200, y: 200, width: 800, height: 600 })),
      setMenu: vi.fn(),
    };
    mockWindowInstances.push(instance);
    return instance;
  });
  (BrowserWindow as unknown as { fromWebContents: ReturnType<typeof vi.fn> }).fromWebContents = vi.fn(() => null);
  (BrowserWindow as unknown as { fromId: ReturnType<typeof vi.fn> }).fromId = vi.fn(() => null);

  return {
    BrowserWindow,
    ipcMain: {
      handle: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
        handleMap.set(channel, fn);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    screen: {
      getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
      getDisplayNearestPoint: vi.fn(() => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } })),
    },
  };
});

import { WindowManager } from "../main/window-manager.js";

const trustedEvent = () =>
  ({ senderFrame: { url: "file:///Applications/Lvis.app/dist/index.html" }, sender: {} }) as unknown as IpcMainInvokeEvent;
const pluginShellEvent = () =>
  ({ senderFrame: { url: "file:///Applications/Lvis.app/dist/plugin-ui-shell.html" }, sender: {} }) as unknown as IpcMainInvokeEvent;
const unauthorizedEvent = () =>
  ({ senderFrame: { url: "https://evil.example.com/pwn" }, sender: {} }) as unknown as IpcMainInvokeEvent;

const payload = (serverId: string, resourceUri = "ui://card/1"): McpUiPayload => ({ serverId, resourceUri });

function makeManager() {
  return new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
}

beforeEach(() => {
  mockWindowInstances.length = 0;
  handleMap.clear();
  nextWindowId = 1;
});

// ── ALLOWED_VIEW_KEYS ──────────────────────────────────────────────────────
describe("ALLOWED_VIEW_KEYS — mcp-app segment", () => {
  it("accepts mcp-app:<hex>:<cardId>", () => {
    expect(ALLOWED_VIEW_KEYS.test("mcp-app:676974687562:1b4e28ba-2fa1-11d2-883f-0016d3cca427")).toBe(true);
    expect(ALLOWED_VIEW_KEYS.test(mcpAppViewKey("github", "card-1"))).toBe(true);
  });

  it("rejects malformed mcp-app keys", () => {
    expect(ALLOWED_VIEW_KEYS.test("mcp-app::x")).toBe(false); // empty hex
    expect(ALLOWED_VIEW_KEYS.test("mcp-app:XYZ:x")).toBe(false); // non-hex serverId
    expect(ALLOWED_VIEW_KEYS.test("mcp-app:ab:")).toBe(false); // empty cardId
    expect(ALLOWED_VIEW_KEYS.test("mcp-app:ab")).toBe(false); // missing cardId segment
  });
});

// ── will-attach allowlist ──────────────────────────────────────────────────
describe("will-attach-webview allowlist (b2 widening)", () => {
  function attachHandlerFor(serverId: string): { willAttach: WillAttach; webviewTag: unknown } {
    const wm = makeManager();
    wm.openDetachedMcpApp(payload(serverId));
    const inst = mockWindowInstances[0];
    expect(inst.willAttach).toBeTypeOf("function");
    return {
      willAttach: inst.willAttach!,
      webviewTag: (inst.opts.webPreferences as Record<string, unknown>).webviewTag,
    };
  }

  it("enables webviewTag for an mcp-app window", () => {
    expect(attachHandlerFor("github").webviewTag).toBe(true);
  });

  it("accepts the per-server lvis-mcp-app partition", () => {
    const { willAttach } = attachHandlerFor("github");
    const prevent = vi.fn();
    willAttach({ preventDefault: prevent }, {}, { partition: mcpAppPartitionName("github") });
    expect(prevent).not.toHaveBeenCalled();
  });

  it("accepts a persist:plugin partition (unchanged)", () => {
    const { willAttach } = attachHandlerFor("github");
    const prevent = vi.fn();
    willAttach({ preventDefault: prevent }, {}, { partition: "persist:plugin:abc" });
    expect(prevent).not.toHaveBeenCalled();
  });

  it("preventDefaults any other partition (fail-closed) and hardens prefs", () => {
    const { willAttach } = attachHandlerFor("github");
    for (const partition of ["default", "persist:other", "lvis-render-html", undefined]) {
      const prevent = vi.fn();
      const prefs: Record<string, unknown> = { preload: "/evil", sandbox: false, nodeIntegration: true };
      willAttach({ preventDefault: prevent }, prefs, { partition });
      expect(prevent, `partition=${String(partition)}`).toHaveBeenCalled();
      // Hardening applies regardless.
      expect(prefs.preload).toBeUndefined();
      expect(prefs.sandbox).toBe(true);
      expect(prefs.nodeIntegration).toBe(false);
    }
  });
});

// ── payload registry ───────────────────────────────────────────────────────
describe("openDetachedMcpApp + registry", () => {
  it("mints a host-side viewKey and stores the payload for retrieval", () => {
    const wm = makeManager();
    const p = payload("github", "ui://card/xyz");
    wm.openDetachedMcpApp(p);
    const viewKey = wm.listChildren()[0].viewKey;
    expect(viewKey.startsWith("mcp-app:")).toBe(true);
    expect(ALLOWED_VIEW_KEYS.test(viewKey)).toBe(true);
    expect(wm.getMcpDetachedPayload(viewKey)).toEqual(p);
    // window title comes from the payload path, not the raw viewKey
    expect(mockWindowInstances[0].title).toBe("LVIS — MCP App");
  });

  it("returns null for an unknown viewKey", () => {
    const wm = makeManager();
    expect(wm.getMcpDetachedPayload("mcp-app:ffff:none")).toBeNull();
  });

  it("purges the payload when the shell is destroyed for a built-in category switch", () => {
    // Repro of the cluster MINOR: free-floating(mcp-app) → built-in swap destroys
    // the shell; the `_children.delete` happens before destroy(), so the closed
    // handler can't purge — the mismatch branch must purge explicitly.
    const wm = makeManager();
    wm.openDetachedMcpApp(payload("github"));
    const viewKey = wm.listChildren()[0].viewKey;
    expect(wm.getMcpDetachedPayload(viewKey)).toBeTruthy();

    wm.openDetachedTab("reminders"); // built-in → category switch → shell destroyed
    expect(wm.getMcpDetachedPayload(viewKey)).toBeNull();
  });

  it("purges the payload when navigating in-place to a plugin view", () => {
    // Both free-floating ⇒ in-place navigate (no destroy); the openDetachedTab
    // chokepoint purges the outgoing mcp-app payload.
    const wm = makeManager();
    wm.openDetachedMcpApp(payload("github"));
    const viewKey = wm.listChildren()[0].viewKey;
    expect(wm.getMcpDetachedPayload(viewKey)).toBeTruthy();

    wm.openDetachedTab("plugin:meeting:main");
    expect(wm.getMcpDetachedPayload(viewKey)).toBeNull();
  });

  it("purges the payload on window close", () => {
    const wm = makeManager();
    wm.openDetachedMcpApp(payload("github"));
    const viewKey = wm.listChildren()[0].viewKey;
    mockWindowInstances[0].close(); // fires the closed handler
    expect(wm.getMcpDetachedPayload(viewKey)).toBeNull();
  });
});

// ── scoped close ───────────────────────────────────────────────────────────
describe("closeDetachedMcpWindows (b3 scoped close)", () => {
  function injectChild(wm: WindowManager, id: number, viewKey: string, p?: McpUiPayload) {
    const win = { id, isDestroyed: vi.fn(() => false), close: vi.fn(), webContents: { id, once: vi.fn() } };
    (wm as unknown as { _children: Map<number, { window: typeof win; viewKey: string }> })._children.set(id, { window: win, viewKey });
    if (p) (wm as unknown as { _mcpDetachedPayloads: Map<string, McpUiPayload> })._mcpDetachedPayloads.set(viewKey, p);
    return win;
  }

  it("closes ONLY the disconnected server's windows and purges their payloads", () => {
    const wm = makeManager();
    const keyA = mcpAppViewKey("github", "a1");
    const keyB = mcpAppViewKey("gitlab", "b1");
    const a = injectChild(wm, 11, keyA, payload("github"));
    const b = injectChild(wm, 12, keyB, payload("gitlab"));
    const plugin = injectChild(wm, 13, "plugin:meeting:main");

    wm.closeDetachedMcpWindows("github");

    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).not.toHaveBeenCalled();
    expect(plugin.close).not.toHaveBeenCalled();
    expect(wm.getMcpDetachedPayload(keyA)).toBeNull(); // purged
    expect(wm.getMcpDetachedPayload(keyB)).toEqual(payload("gitlab")); // intact
  });
});

// ── IPC ────────────────────────────────────────────────────────────────────
describe("lvis:mcp:open-detached IPC", () => {
  function register() {
    const wm = makeManager();
    wm.registerIpc({ log: vi.fn() } as never);
    return wm;
  }

  it("rejects an unauthorized sender", async () => {
    register();
    const handler = handleMap.get("lvis:mcp:open-detached")!;
    expect(await handler(unauthorizedEvent(), { payload: payload("github") })).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("rejects a plugin-ui-shell frame (validateHostRendererSender)", async () => {
    register();
    const handler = handleMap.get("lvis:mcp:open-detached")!;
    expect(await handler(pluginShellEvent(), { payload: payload("github") })).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("rejects a non-ui:// resourceUri and an empty serverId (fail-closed)", async () => {
    register();
    const handler = handleMap.get("lvis:mcp:open-detached")!;
    expect(await handler(trustedEvent(), { payload: { serverId: "github", resourceUri: "http://evil" } })).toEqual({ ok: false, error: "invalid-payload" });
    expect(await handler(trustedEvent(), { payload: { serverId: "  ", resourceUri: "ui://x" } })).toEqual({ ok: false, error: "invalid-payload" });
    expect(await handler(trustedEvent(), {})).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("opens a detached window for a valid payload", async () => {
    const wm = register();
    const handler = handleMap.get("lvis:mcp:open-detached")!;
    const result = (await handler(trustedEvent(), { payload: payload("github") })) as { ok: boolean; windowId?: number };
    expect(result.ok).toBe(true);
    expect(typeof result.windowId).toBe("number");
    expect(wm.listChildren()[0].viewKey.startsWith("mcp-app:")).toBe(true);
  });

  it("detached-payload read returns the stored payload and rejects unauthorized senders", async () => {
    const wm = register();
    const p = payload("github", "ui://card/z");
    wm.openDetachedMcpApp(p);
    const viewKey = wm.listChildren()[0].viewKey;
    const read = handleMap.get("lvis:mcp:detached-payload")!;
    expect(await read(trustedEvent(), viewKey)).toEqual(p);
    expect(await read(unauthorizedEvent(), viewKey)).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});
