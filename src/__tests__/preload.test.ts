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
const originalLvisDevEnv = process.env.LVIS_DEV;
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
    delete process.env.LVIS_DEV;
    delete process.env.LVIS_DEV_CONSOLE;
  });

  afterEach(() => {
    if (originalDebugStreamEnv === undefined) {
      delete process.env.VITE_DEBUG_STREAM;
    } else {
      process.env.VITE_DEBUG_STREAM = originalDebugStreamEnv;
    }
    if (originalLvisDevEnv === undefined) {
      delete process.env.LVIS_DEV;
    } else {
      process.env.LVIS_DEV = originalLvisDevEnv;
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
      enableDevConsole: false,
      debugStream: false,
    });
  });

  it("reflects VITE_DEBUG_STREAM in the preload bridge", async () => {
    process.env.VITE_DEBUG_STREAM = "1";
    const lvis = await loadLvisNamespace();
    const env = lvis["env"] as Record<string, unknown>;

    expect(env["debugStream"]).toBe(true);
  });

  it("enables debugStream when the dev console is enabled in dev mode", async () => {
    process.env.LVIS_DEV = "1";
    process.env.LVIS_DEV_CONSOLE = "1";
    const lvis = await loadLvisNamespace();
    const env = lvis["env"] as Record<string, unknown>;

    expect(env["debugStream"]).toBe(true);
  });

  it("exposes memoryGetIndex and invokes the memory index IPC channel", async () => {
    const api = await loadLvisApi();

    expect(typeof api["memoryGetIndex"]).toBe("function");
    await (api["memoryGetIndex"] as () => Promise<unknown>)();

    expect(mockInvoke).toHaveBeenCalledWith("lvis:memory:index:get");
  });

  it.each([
    ["memoryGetAgentsMd", "lvis:memory:agents-md:get"],
    ["memoryUpdateAgentsMd", "lvis:memory:agents-md:update", "# Agents"],
    ["memoryGetLvisMd", "lvis:memory:lvis-md:get"],
    ["memoryUpdateLvisMd", "lvis:memory:lvis-md:update", "# Agents"],
    ["memoryGetUserPrefs", "lvis:memory:user-prefs:get"],
    ["memoryUpdateUserPrefs", "lvis:memory:user-prefs:update", "# Preferences"],
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
});
