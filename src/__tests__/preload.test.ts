/**
 * Host preload — deterministic plugin webview asset URLs
 *
 * Verifies that `src/preload.ts` exposes `pluginPreloadUrl` and
 * `pluginShellUrl` on `window.lvisApi` as `file://` strings rooted under
 * `dist/src/`. These power the plugin UI host's <webview> wiring without
 * relying on `window.location.href`, which can be a splash-phase data: URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockUserActivation = { isActive: false };
const originalDebugStreamEnv = process.env.VITE_DEBUG_STREAM;
const originalLvisDebugStreamEnv = process.env.LVIS_DEBUG_STREAM;
const originalLvisDevEnv = process.env.LVIS_DEV;
const originalLvisE2eEnv = process.env.LVIS_E2E;
const originalLvisDevConsoleEnv = process.env.LVIS_DEV_CONSOLE;

// Named exports only — mirrors the named-import shape in preload.ts.
// A regression to `import electron from "electron"` will fail here because
// the mock no longer supplies a `.default` object.
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      exposed.set(key, value);
    }),
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}));

// Node/bun runtimes differ on whether `globalThis.navigator` exists: some
// (e.g. older bun, plain node before the Navigator global) leave it undefined,
// which makes `defineProperty` throw "called on non-object". Define a stub
// first so the test does not assume the host runtime already provides one.
if (typeof globalThis.navigator !== "object" || globalThis.navigator === null) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
}
Object.defineProperty(globalThis.navigator, "userActivation", {
  configurable: true,
  value: mockUserActivation,
});

async function loadLvisApi(): Promise<Record<string, unknown>> {
  await import("../preload.js");
  const api = exposed.get("lvisApi");
  if (!api || typeof api !== "object") {
    throw new Error("lvisApi was not exposed");
  }
  return api as Record<string, unknown>;
}

async function loadLvisNamespace(): Promise<Record<string, unknown>> {
  await import("../preload.js");
  const lvis = exposed.get("lvis");
  if (!lvis || typeof lvis !== "object") {
    throw new Error("lvis was not exposed");
  }
  return lvis as Record<string, unknown>;
}

describe("preload — plugin webview asset URLs", () => {
  beforeEach(() => {
    exposed.clear();
    mockInvoke.mockReset();
    mockOn.mockReset();
    mockRemoveListener.mockReset();
    mockUserActivation.isActive = false;
    vi.resetModules();
    delete process.env.VITE_DEBUG_STREAM;
    delete process.env.LVIS_DEBUG_STREAM;
    delete process.env.LVIS_DEV;
    delete process.env.LVIS_E2E;
    delete process.env.LVIS_DEV_CONSOLE;
  });

  afterEach(() => {
    if (originalDebugStreamEnv === undefined) {
      delete process.env.VITE_DEBUG_STREAM;
    } else {
      process.env.VITE_DEBUG_STREAM = originalDebugStreamEnv;
    }
    if (originalLvisDebugStreamEnv === undefined) {
      delete process.env.LVIS_DEBUG_STREAM;
    } else {
      process.env.LVIS_DEBUG_STREAM = originalLvisDebugStreamEnv;
    }
    if (originalLvisDevEnv === undefined) {
      delete process.env.LVIS_DEV;
    } else {
      process.env.LVIS_DEV = originalLvisDevEnv;
    }
    if (originalLvisE2eEnv === undefined) {
      delete process.env.LVIS_E2E;
    } else {
      process.env.LVIS_E2E = originalLvisE2eEnv;
    }
    if (originalLvisDevConsoleEnv === undefined) {
      delete process.env.LVIS_DEV_CONSOLE;
    } else {
      process.env.LVIS_DEV_CONSOLE = originalLvisDevConsoleEnv;
    }
  });

  it("exposes pluginPreloadUrl as a file:// string under dist/src/", async () => {
    const api = await loadLvisApi();
    const url = api["pluginPreloadUrl"];

    expect(typeof url).toBe("string");
    expect(url as string).toMatch(/^file:\/\//);
    // Anchor on the filename so the assertion catches regressions where the
    // path points to a wrong directory (e.g. dist/main/ instead of dist/src/).
    // __dirname is `src/` at test-time or `dist/src/` in production builds.
    expect(url as string).toMatch(/\/(dist\/)?src\/plugin-preload\.cjs$/i);
  });

  it("exposes pluginShellUrl as a file:// string under dist/src/", async () => {
    const api = await loadLvisApi();
    const url = api["pluginShellUrl"];

    expect(typeof url).toBe("string");
    expect(url as string).toMatch(/^file:\/\//);
    expect(url as string).toMatch(/\/plugin-ui-shell\.html$/i);
  });

  it("bridges render_html previews through the exact window IPC channel", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, windowId: 9 });
    const api = await loadLvisApi();
    const windowApi = api["window"] as Record<string, unknown>;
    const payload = {
      html: "<main>preview</main>",
      title: "Preview",
      allowScripts: true,
    };

    const result = await (windowApi["openHtmlPreview"] as (value: typeof payload) => Promise<unknown>)(payload);

    expect(result).toEqual({ ok: true, windowId: 9 });
    expect(mockInvoke).toHaveBeenCalledWith("lvis:window:open-html-preview", payload);
  });

  it("plugin asset URLs are static strings, not functions", async () => {
    const api = await loadLvisApi();

    expect(typeof api["pluginPreloadUrl"]).toBe("string");
    expect(typeof api["pluginShellUrl"]).toBe("string");
    expect(typeof api["pluginPreloadUrl"]).not.toBe("function");
    expect(typeof api["pluginShellUrl"]).not.toBe("function");
  });

  it("exposes chat user-intent capture through preload", async () => {
    const api = await loadLvisApi();

    expect(typeof api["captureUserKeyboardIntent"]).toBe("function");
  });

  it("keeps provider-backed usage daily summary out of the public preload surface", async () => {
    const { buildPublicSurface } = await import("../preload/public-surface.js");
    const publicApi = buildPublicSurface() as Record<string, unknown>;

    expect(typeof publicApi["getUsageSummary"]).toBe("function");
    expect(typeof publicApi["getUsageRange"]).toBe("function");
    expect(publicApi["getUsageDailySummary"]).toBeUndefined();
  });

  it("exposes settings updated subscription through preload", async () => {
    const api = await loadLvisApi();
    const handler = vi.fn();
    const unsubscribe = (api["onSettingsUpdated"] as (cb: (settings: unknown) => void) => () => void)(handler);

    expect(mockOn).toHaveBeenCalledWith("lvis:settings:updated", expect.any(Function));
    const listener = mockOn.mock.calls.at(-1)?.[1] as (event: unknown, settings: unknown) => void;
    const settings = { appearance: { schemaVersion: 2, bundleId: "forest" } };
    listener({}, settings);
    expect(handler).toHaveBeenCalledWith(settings);

    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith("lvis:settings:updated", listener);
  });

  it("does not trust renderer-minted chat userActivation flags", async () => {
    const api = await loadLvisApi();
    const chatSend = api["chatSend"] as (
      input: string,
      attachments: unknown[] | undefined,
      inputOrigin: string,
      userIntent?: unknown,
    ) => Promise<unknown>;

    await chatSend("hello", undefined, "user-keyboard", {
      inputOrigin: "user-keyboard",
      userActivation: true,
    });

    expect(mockInvoke).toHaveBeenCalledWith("lvis:chat:send", expect.objectContaining({
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: false,
    }));
  });

  it("does not trust renderer-minted plugin userAction flags", async () => {
    const api = await loadLvisApi();
    const callPluginMethod = api["callPluginMethod"] as (
      method: string,
      payload?: unknown,
      options?: { userAction?: boolean },
    ) => Promise<unknown>;

    await callPluginMethod("sample_ui_action", { id: 1 }, { userAction: true });

    expect(mockInvoke).toHaveBeenCalledWith("lvis:plugins:call", "sample_ui_action", { id: 1 }, {
      userAction: false,
    });
  });

  it("forwards plugin userAction only during active browser user activation", async () => {
    mockUserActivation.isActive = true;
    const api = await loadLvisApi();
    const callPluginMethod = api["callPluginMethod"] as (
      method: string,
      payload?: unknown,
      options?: { userAction?: boolean },
    ) => Promise<unknown>;

    await callPluginMethod("sample_ui_action", undefined, { userAction: true });

    expect(mockInvoke).toHaveBeenCalledWith("lvis:plugins:call", "sample_ui_action", undefined, {
      userAction: true,
    });
  });

  it("forwards the opaque operation grant token on plugin calls", async () => {
    const api = await loadLvisApi();
    const callPluginMethod = api["callPluginMethod"] as (
      method: string,
      payload?: unknown,
      options?: { operationGrantToken?: string },
    ) => Promise<unknown>;

    await callPluginMethod(
      "attendance_write",
      { operation: "clock_in" },
      { operationGrantToken: "grant-once" },
    );

    expect(mockInvoke).toHaveBeenCalledWith(
      "lvis:plugins:call",
      "attendance_write",
      { operation: "clock_in" },
      { userAction: false, operationGrantToken: "grant-once" },
    );
  });

  it("pins MCP app resource and tool calls to the supplied generation", async () => {
    const api = await loadLvisApi();
    const mcp = api["mcp"] as {
      readUiResource(
        serverId: string,
        uri: string,
        generationId?: string,
      ): Promise<unknown>;
      callTool(
        serverId: string,
        name: string,
        args: Record<string, unknown>,
        generationId?: string,
      ): Promise<unknown>;
    };

    await mcp.readUiResource("plugin:ep-api:mcp:work", "ui://attendance", "generation-a");
    await mcp.callTool(
      "plugin:ep-api:mcp:work",
      "attendance_read",
      { operation: "today" },
      "generation-a",
    );

    expect(mockInvoke).toHaveBeenCalledWith(
      "lvis:mcp:ui-resource",
      "plugin:ep-api:mcp:work",
      "ui://attendance",
      "generation-a",
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "lvis:mcp:call-tool",
      "plugin:ep-api:mcp:work",
      "attendance_read",
      { operation: "today" },
      "generation-a",
    );
  });

  it("consumes captured chat user-intent tokens exactly once", async () => {
    mockUserActivation.isActive = true;
    const api = await loadLvisApi();
    const capture = api["captureUserKeyboardIntent"] as () => unknown;
    const chatSend = api["chatSend"] as (
      input: string,
      attachments: unknown[] | undefined,
      inputOrigin: string,
      userIntent?: unknown,
    ) => Promise<unknown>;
    const token = capture();

    await chatSend("first", undefined, "user-keyboard", token);
    mockUserActivation.isActive = false;
    await chatSend("second", undefined, "user-keyboard", token);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "lvis:chat:send", expect.objectContaining({
      input: "first",
      userActivation: true,
    }));
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "lvis:chat:send", expect.objectContaining({
      input: "second",
      userActivation: false,
    }));
  });

  it("exposes renderer env flags including debugStream", async () => {
    const lvis = await loadLvisNamespace();
    const env = lvis["env"] as Record<string, unknown>;

    expect(env).toMatchObject({
      isDev: false,
      isE2E: false,
      enableDevConsole: false,
      debugStream: false,
    });
  });

  it("reflects LVIS_E2E in the preload bridge", async () => {
    process.env.LVIS_E2E = "1";
    const lvis = await loadLvisNamespace();
    const env = lvis["env"] as Record<string, unknown>;

    expect(env["isE2E"]).toBe(true);
    expect(env["debugStream"]).toBe(false);
  });

  it("does not treat LVIS_E2E as dev mode by itself", async () => {
    process.env.LVIS_E2E = "1";
    const lvis = await loadLvisNamespace();
    const env = lvis["env"] as Record<string, unknown>;

    expect(env["isDev"]).toBe(false);
    expect(env["isE2E"]).toBe(true);
  });

  it("reflects VITE_DEBUG_STREAM in the preload bridge", async () => {
    process.env.VITE_DEBUG_STREAM = "1";
    const lvis = await loadLvisNamespace();
    const env = lvis["env"] as Record<string, unknown>;

    expect(env["debugStream"]).toBe(true);
  });

  it("keeps debugStream separate from the dev console flag", async () => {
    process.env.LVIS_DEV = "1";
    process.env.LVIS_DEV_CONSOLE = "1";
    const lvis = await loadLvisNamespace();
    const env = lvis["env"] as Record<string, unknown>;

    expect(env["enableDevConsole"]).toBe(true);
    expect(env["debugStream"]).toBe(false);
  });

  it("reflects LVIS_DEBUG_STREAM in the preload bridge", async () => {
    process.env.LVIS_DEV = "1";
    process.env.LVIS_DEV_CONSOLE = "1";
    process.env.LVIS_DEBUG_STREAM = "1";
    const lvis = await loadLvisNamespace();
    const env = lvis["env"] as Record<string, unknown>;

    expect(env["debugStream"]).toBe(true);
  });

  it("exposes memoryGetIndex and invokes the memory index IPC channel", async () => {
    const api = await loadLvisApi();

    expect(typeof api["memoryGetIndex"]).toBe("function");
    expect(api["memoryUpdateIndex"]).toBeUndefined();
    await (api["memoryGetIndex"] as () => Promise<unknown>)();

    expect(mockInvoke).toHaveBeenCalledWith("lvis:memory:index:get");
  });

  it.each([
    ["memoryGetAgentsMd", "lvis:memory:agents-md:get"],
    ["memoryUpdateAgentsMd", "lvis:memory:agents-md:update", "# Agents"],
    ["memoryUpdateIndexSections", "lvis:memory:index:sections:update", { urgentMemory: "Keep this." }],
    ["memoryGetUserPrefs", "lvis:memory:user-prefs:get"],
    ["memoryUpdateUserPrefs", "lvis:memory:user-prefs:update", "# Preferences"],
    ["memoryRefreshUserPrefs", "lvis:memory:user-prefs:refresh"],
  ])("exposes %s and invokes %s", async (apiKey, channel, payload) => {
    const api = await loadLvisApi();

    expect(typeof api[apiKey]).toBe("function");
    await (api[apiKey] as (value?: string) => Promise<unknown>)(payload);

    if (payload === undefined) {
      expect(mockInvoke).toHaveBeenCalledWith(channel);
    } else {
      expect(mockInvoke).toHaveBeenCalledWith(channel, payload);
    }
  });

  it("exposes memoryUpdateIndexIfUnchanged with expected and next content", async () => {
    const api = await loadLvisApi();

    expect(typeof api["memoryUpdateIndexIfUnchanged"]).toBe("function");
    await (api["memoryUpdateIndexIfUnchanged"] as (expected: string, next: string) => Promise<unknown>)("# Old", "# New");

    expect(mockInvoke).toHaveBeenCalledWith("lvis:memory:index:update-if-unchanged", "# Old", "# New");
  });
});
