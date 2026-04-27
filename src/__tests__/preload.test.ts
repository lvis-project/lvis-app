/**
 * Host preload — deterministic plugin webview asset URLs
 *
 * Verifies that `src/preload.ts` exposes `pluginPreloadUrl` and
 * `pluginShellUrl` on `window.lvisApi` as `file://` strings rooted under
 * `dist/src/`. These power the plugin UI host's <webview> wiring without
 * relying on `window.location.href`, which can be a splash-phase data: URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock("electron", () => ({
  default: {
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
  },
}));

async function loadLvisApi(): Promise<Record<string, unknown>> {
  await import("../preload.js");
  const api = exposed.get("lvisApi");
  if (!api || typeof api !== "object") {
    throw new Error("lvisApi was not exposed");
  }
  return api as Record<string, unknown>;
}

describe("preload — plugin webview asset URLs", () => {
  beforeEach(() => {
    exposed.clear();
    mockInvoke.mockReset();
    mockOn.mockReset();
    mockRemoveListener.mockReset();
    vi.resetModules();
  });

  it("exposes pluginPreloadUrl as a file:// string under dist/src/", async () => {
    const api = await loadLvisApi();
    const url = api["pluginPreloadUrl"];

    expect(typeof url).toBe("string");
    expect(url as string).toMatch(/^file:\/\//);
    expect(url as string).toContain("plugin-preload.js");
    // __dirname of preload.ts is `src/` at test-time (ts-source) or
    // `dist/src/` in production. Either path segment is acceptable.
    expect((url as string).toLowerCase()).toMatch(/\/src\//);
  });

  it("exposes pluginShellUrl as a file:// string under dist/src/", async () => {
    const api = await loadLvisApi();
    const url = api["pluginShellUrl"];

    expect(typeof url).toBe("string");
    expect(url as string).toMatch(/^file:\/\//);
    expect(url as string).toContain("plugin-ui-shell.html");
    expect((url as string).toLowerCase()).toMatch(/\/src\//);
  });

  it("plugin asset URLs are static strings, not functions", async () => {
    const api = await loadLvisApi();

    expect(typeof api["pluginPreloadUrl"]).toBe("string");
    expect(typeof api["pluginShellUrl"]).toBe("string");
    expect(typeof api["pluginPreloadUrl"]).not.toBe("function");
    expect(typeof api["pluginShellUrl"]).not.toBe("function");
  });
});
