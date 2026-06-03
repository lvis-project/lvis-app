import { beforeEach, describe, expect, it, vi } from "vitest";

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

// Named exports only — mirrors the named-import shape in preload.ts.
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

type ExposedApi = {
  takePluginMarketplaceApi: () => {
    installMarketplacePlugin: (pluginId: string) => Promise<unknown>;
    uninstallMarketplacePlugin: (pluginId: string) => Promise<unknown>;
  } | null;
};

async function loadExposedApi(): Promise<ExposedApi> {
  await import("../preload.js");
  const api = exposed.get("lvisHost");
  if (!api || typeof api !== "object") {
    throw new Error("lvisHost was not exposed");
  }
  return api as ExposedApi;
}

describe("preload plugin action normalization", () => {
  beforeEach(() => {
    exposed.clear();
    mockInvoke.mockReset();
    mockOn.mockReset();
    mockRemoveListener.mockReset();
    vi.resetModules();
  });

  it("rejects malformed install payloads as invalid-result", async () => {
    mockInvoke.mockResolvedValueOnce({ installed: true });
    const api = await loadExposedApi();
    const hostApi = api.takePluginMarketplaceApi();
    if (!hostApi) throw new Error("host plugin marketplace api unavailable");

    await expect(hostApi.installMarketplacePlugin("meeting")).resolves.toEqual({
      ok: false,
      error: "invalid-result",
      // preload resolves i18n at the English default — it has no settings
      // context to switch language, and this suite re-imports it via
      // resetModules so the runtime locale is the default.
      message: "Plugin action result is invalid.",
    });
  });

  it("preserves valid uninstall payloads", async () => {
    mockInvoke.mockResolvedValueOnce({ pluginId: "meeting", uninstalled: true });
    const api = await loadExposedApi();
    const hostApi = api.takePluginMarketplaceApi();
    if (!hostApi) throw new Error("host plugin marketplace api unavailable");

    await expect(hostApi.uninstallMarketplacePlugin("meeting")).resolves.toEqual({
      ok: true,
      pluginId: "meeting",
      uninstalled: true,
    });
  });

  it("allows the host marketplace api to be claimed only once", async () => {
    const api = await loadExposedApi();

    expect(api.takePluginMarketplaceApi()).not.toBeNull();
    expect(api.takePluginMarketplaceApi()).toBeNull();
  });
});
