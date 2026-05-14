import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const sendSpy = vi.fn();
const fromIdSpy = vi.fn();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/lvis-test", whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: (...args: unknown[]) => fromIdSpy(...args) },
  dialog: {},
  shell: {},
}));

import {
  recordValidatedTheme,
  getLastThemePayload,
  replayThemeToWebview,
  publishHostThemeChanged,
  __resetLastThemePayloadForTests,
  registerPluginsHandlers,
  unregisterPluginWebview,
} from "../domains/plugins.js";
import { ipcMain } from "electron";
import { onEvent } from "../../boot/types.js";
import { HOST_ONLY_EMIT_NAMESPACES } from "../../plugins/capabilities.js";
import type { IpcDeps } from "../types.js";

type IpcHandler = (...args: unknown[]) => unknown;

function handleSpy(): ReturnType<typeof vi.fn> {
  return ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
}

function getRegisteredHandler(channel: string): IpcHandler {
  const call = handleSpy().mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!call) throw new Error(`missing IPC handler for ${channel}`);
  return call[1] as IpcHandler;
}

function rendererEvent(): unknown {
  return { senderFrame: { url: "file:///tmp/lvis/index.html" } };
}

function pluginEvent(webContentsId: number): unknown {
  return {
    sender: { id: webContentsId },
    senderFrame: { url: "file:///tmp/lvis/plugin-ui-shell.html" },
  };
}

function createPluginFixture(): { root: string; entryUrl: string } {
  const root = mkdtempSync(join(tmpdir(), "lvis-plugin-ipc-"));
  const entry = join(root, "index.html");
  writeFileSync(entry, "<!doctype html>");
  return { root, entryUrl: pathToFileURL(entry).toString() };
}

function createDeps(pluginRoot: string): {
  deps: IpcDeps;
  pluginRuntime: {
    getPluginManifest: ReturnType<typeof vi.fn>;
    getPluginRoot: ReturnType<typeof vi.fn>;
    assertPluginEventEmitAccess: ReturnType<typeof vi.fn>;
  };
} {
  const pluginRuntime = {
    getPluginManifest: vi.fn(() => ({
      id: "meeting",
      capabilities: ["meeting-recorder"],
    })),
    getPluginRoot: vi.fn(() => pluginRoot),
    assertPluginEventEmitAccess: vi.fn(),
  };
  const deps = {
    pluginRuntime,
    pluginMarketplace: {},
    settingsService: { get: vi.fn(), set: vi.fn() },
    memoryManager: {},
    keywordEngine: {},
    routeEngine: {},
    toolRegistry: {},
    systemPromptBuilder: {},
    conversationLoop: {},
    mcpManager: {},
    bashAstValidator: {},
    auditService: {},
    auditLogger: { log: vi.fn() },
    postTurnHookChain: {},
    knowledgeAvailable: false,
    refreshPluginNotifications: vi.fn(),
    notificationService: {},
    getMainWindow: () => null,
    getAppWindows: () => [],
  } as unknown as IpcDeps;
  return { deps, pluginRuntime };
}

function registerHandlersWithPlugin(webContentsId: number): {
  pluginRuntime: ReturnType<typeof createDeps>["pluginRuntime"];
} {
  const { root, entryUrl } = createPluginFixture();
  const { deps, pluginRuntime } = createDeps(root);
  registerPluginsHandlers(deps);
  const registerWebview = getRegisteredHandler("lvis:plugin:register-webview");
  expect(registerWebview(rendererEvent(), { webContentsId, pluginId: "meeting", entryUrl })).toEqual({ ok: true });
  return { pluginRuntime };
}

describe("plugin theme replay cache", () => {
  beforeEach(() => {
    __resetLastThemePayloadForTests();
  });

  it("starts empty", () => {
    expect(getLastThemePayload()).toBeNull();
  });

  it("records a valid payload", () => {
    const result = recordValidatedTheme({
      bundleId: "midnight",
      shell: "dark",
      tokens: { "--lvis-bg": "#000" },
    });
    expect(result.ok).toBe(true);
    expect(getLastThemePayload()).toEqual({
      bundleId: "midnight",
      shell: "dark",
      tokens: { "--lvis-bg": "#000" },
    });
    expect(Object.isFrozen(result.safe)).toBe(true);
    expect(Object.isFrozen(result.safe.tokens)).toBe(true);
  });

  it("returns cloned cache snapshots so callers cannot poison the replay cache", () => {
    recordValidatedTheme({ bundleId: "lge-dark", shell: "dark", tokens: { "--lvis-bg": "#111" } });
    const cached = getLastThemePayload();
    expect(cached).toEqual({
      bundleId: "lge-dark",
      shell: "dark",
      tokens: { "--lvis-bg": "#111" },
    });
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached?.tokens)).toBe(true);

    try {
      (cached!.tokens as Record<string, string>)["--lvis-bg"] = "#fff";
    } catch {
      /* frozen in strict runtimes */
    }

    expect(getLastThemePayload()).toEqual({
      bundleId: "lge-dark",
      shell: "dark",
      tokens: { "--lvis-bg": "#111" },
    });
  });

  it("invalid payload leaves the existing cache untouched", () => {
    recordValidatedTheme({ bundleId: "lge-light", shell: "light", tokens: { "--lvis-bg": "#fff" } });
    const before = getLastThemePayload();

    const result = recordValidatedTheme({ bundleId: "sepia", shell: "light" });
    expect(result.ok).toBe(false);

    expect(getLastThemePayload()).toEqual(before);
  });

  it("overwrites earlier payload on each new valid call", () => {
    recordValidatedTheme({ bundleId: "lge-dark", shell: "dark", tokens: { "--lvis-bg": "#111" } });
    recordValidatedTheme({ bundleId: "forest", shell: "light", tokens: { "--lvis-bg": "#eee" } });

    expect(getLastThemePayload()).toEqual({
      bundleId: "forest",
      shell: "light",
      tokens: { "--lvis-bg": "#eee" },
    });
  });

  it("preserves filtered tokens in the cached payload", () => {
    recordValidatedTheme({
      bundleId: "lge-dark",
      shell: "dark",
      tokens: { "--lvis-bg": "#111", "--evil-key": "red" },
    });

    expect(getLastThemePayload()).toEqual({
      bundleId: "lge-dark",
      shell: "dark",
      tokens: { "--lvis-bg": "#111" },
    });
  });

  it("records bundleId and shell correctly", () => {
    recordValidatedTheme({
      bundleId: "forest",
      shell: "light",
      tokens: { "--lvis-bg": "#eee" },
    });

    const cached = getLastThemePayload();
    expect(cached?.bundleId).toBe("forest");
    expect(cached?.shell).toBe("light");
  });

  it("unknown bundleId is rejected — cache stays null", () => {
    const result = recordValidatedTheme({
      bundleId: "injected-theme",
      shell: "dark",
    });

    expect(result.ok).toBe(false);
    expect(getLastThemePayload()).toBeNull();
  });
});

describe("replayThemeToWebview", () => {
  beforeEach(() => {
    __resetLastThemePayloadForTests();
    sendSpy.mockReset();
    fromIdSpy.mockReset();
  });

  it("returns null and does not send when the cache is empty", () => {
    fromIdSpy.mockReturnValue({ send: sendSpy, isDestroyed: () => false });

    const result = replayThemeToWebview(42);

    expect(result).toBeNull();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sends host.theme.changed exactly once to the resolved wc when cache is filled", () => {
    fromIdSpy.mockReturnValue({ send: sendSpy, isDestroyed: () => false });
    recordValidatedTheme({ bundleId: "tokyo-night", shell: "dark", tokens: { "--lvis-bg": "#0d0d12" } });

    const result = replayThemeToWebview(42);

    expect(fromIdSpy).toHaveBeenCalledOnce();
    expect(fromIdSpy).toHaveBeenCalledWith(42);
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith(
      "lvis:plugin:event",
      "host.theme.changed",
      { bundleId: "tokyo-night", shell: "dark", tokens: { "--lvis-bg": "#0d0d12" } },
    );
    expect(result).toEqual({ bundleId: "tokyo-night", shell: "dark", tokens: { "--lvis-bg": "#0d0d12" } });
  });

  it("does not send when wc.fromId returns undefined (already-destroyed wcId)", () => {
    fromIdSpy.mockReturnValue(undefined);
    recordValidatedTheme({ bundleId: "lge-light", shell: "light", tokens: { "--lvis-bg": "#fff" } });

    const result = replayThemeToWebview(99);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("does not send when wc.isDestroyed() is true", () => {
    fromIdSpy.mockReturnValue({ send: sendSpy, isDestroyed: () => true });
    recordValidatedTheme({ bundleId: "lge-dark", shell: "dark", tokens: { "--lvis-bg": "#111" } });

    const result = replayThemeToWebview(11);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("swallows wc.send throw without surfacing", () => {
    fromIdSpy.mockReturnValue({
      send: () => { throw new Error("wc gone"); },
      isDestroyed: () => false,
    });
    recordValidatedTheme({ bundleId: "lge-dark", shell: "dark", tokens: { "--lvis-bg": "#111" } });

    expect(() => replayThemeToWebview(7)).not.toThrow();
    expect(replayThemeToWebview(7)).toBeNull();
  });
});

describe("publishHostThemeChanged", () => {
  it("emits an immutable clone on the host event bus", () => {
    const payload = { bundleId: "tokyo-night", shell: "dark" as const, tokens: { "--lvis-bg": "#0d0d12" } };
    const seen: unknown[] = [];
    const unsubscribe = onEvent("host.theme.changed", (data) => {
      expect(data).not.toBe(payload);
      expect(Object.isFrozen(data)).toBe(true);
      expect(Object.isFrozen((data as { tokens?: unknown }).tokens)).toBe(true);
      try {
        ((data as { tokens: Record<string, string> }).tokens)["--lvis-bg"] = "#fff";
      } catch {
        /* frozen in strict runtimes */
      }
      seen.push(data);
    });

    try {
      publishHostThemeChanged(payload);
    } finally {
      unsubscribe();
    }

    expect(seen).toEqual([payload]);
    expect(payload.tokens["--lvis-bg"]).toBe("#0d0d12");
  });
});

describe("HOST_ONLY_EMIT_NAMESPACES", () => {
  it("blocks plugin emits in the `host.*` namespace (closes theme-spoofing surface)", () => {
    expect(HOST_ONLY_EMIT_NAMESPACES.has("host")).toBe(true);
  });

  it("still blocks plugin emits in the `plugin.*` namespace", () => {
    expect(HOST_ONLY_EMIT_NAMESPACES.has("plugin")).toBe(true);
  });
});

describe("plugin theme IPC handlers", () => {
  beforeEach(() => {
    __resetLastThemePayloadForTests();
    handleSpy().mockReset();
    sendSpy.mockReset();
    fromIdSpy.mockReset();
  });

  afterEach(() => {
    unregisterPluginWebview(1701);
    unregisterPluginWebview(1702);
    unregisterPluginWebview(1703);
    __resetLastThemePayloadForTests();
  });

  it("publishes host.theme.changed through the production theme-notify IPC handler", () => {
    fromIdSpy.mockReturnValue({ send: sendSpy, isDestroyed: () => false });
    registerHandlersWithPlugin(1701);
    const themeNotify = getRegisteredHandler("lvis:host:plugin-theme-notify");
    const payload = {
      bundleId: "tokyo-night",
      shell: "dark" as const,
      tokens: { "--lvis-bg": "#0d0d12" },
    };
    const seen: unknown[] = [];
    const unsubscribe = onEvent("host.theme.changed", (data) => {
      expect(data).not.toBe(payload);
      expect(Object.isFrozen(data)).toBe(true);
      expect(Object.isFrozen((data as { tokens?: unknown }).tokens)).toBe(true);
      seen.push(data);
    });

    try {
      expect(themeNotify(rendererEvent(), payload)).toEqual({ ok: true });
    } finally {
      unsubscribe();
    }

    expect(seen).toEqual([payload]);
    expect(getLastThemePayload()).toEqual(payload);
    expect(sendSpy).toHaveBeenCalledWith("lvis:plugin:event", "host.theme.changed", payload);
  });

  it("republishes cached theme through the production webview-register replay path", () => {
    fromIdSpy.mockReturnValue({ send: sendSpy, isDestroyed: () => false });
    const cached = {
      bundleId: "lge-dark",
      shell: "dark" as const,
      tokens: { "--lvis-bg": "#111" },
    };
    recordValidatedTheme(cached);
    const { root, entryUrl } = createPluginFixture();
    const { deps } = createDeps(root);
    registerPluginsHandlers(deps);
    const registerWebview = getRegisteredHandler("lvis:plugin:register-webview");
    const seen: unknown[] = [];
    const unsubscribe = onEvent("host.theme.changed", (data) => {
      expect(data).not.toBe(cached);
      expect(Object.isFrozen(data)).toBe(true);
      expect(Object.isFrozen((data as { tokens?: unknown }).tokens)).toBe(true);
      seen.push(data);
    });

    try {
      expect(registerWebview(rendererEvent(), { webContentsId: 1702, pluginId: "meeting", entryUrl })).toEqual({ ok: true });
    } finally {
      unsubscribe();
    }

    expect(sendSpy).toHaveBeenCalledWith("lvis:plugin:event", "host.theme.changed", cached);
    expect(seen).toEqual([cached]);
  });

  it("rejects host namespace emits through the production plugin emit IPC handler", () => {
    const { pluginRuntime } = registerHandlersWithPlugin(1703);
    const emitEvent = getRegisteredHandler("lvis:plugin:emit-event");
    const seen: unknown[] = [];
    const unsubscribe = onEvent("host.theme.changed", (data) => seen.push(data));

    try {
      expect(emitEvent(pluginEvent(1703), "host.theme.changed", {
        bundleId: "tokyo-night",
        shell: "dark",
        tokens: { "--lvis-bg": "#0d0d12" },
      })).toEqual({ ok: false, error: "host-only-namespace:host" });
    } finally {
      unsubscribe();
    }

    expect(seen).toEqual([]);
    expect(pluginRuntime.assertPluginEventEmitAccess).not.toHaveBeenCalled();
  });
});
