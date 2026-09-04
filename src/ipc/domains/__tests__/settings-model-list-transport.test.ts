/**
 * Model-list sync runs on the transport MAIN supplies, not on ambient `fetch`.
 *
 * Node's `fetch` reads neither the machine's proxy configuration nor its trust
 * store, so a model-list request issued on it goes direct on a machine whose
 * configuration routes that host through a proxy. The engine cannot import
 * Electron to fix that — every test importing it would break — so main hands
 * the transport down through the IPC dependency bag, and this suite is what
 * holds that wire in place.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listLlmModelsFromSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));
vi.mock("../../../engine/llm/model-list.js", () => ({
  listLlmModelsFromSettings: listLlmModelsFromSettingsMock,
}));

const invoke = makeAppIpcInvoker(handlers);

function makeDeps(singleHopNetworkFetch: typeof fetch) {
  return {
    settingsService: {
      getAll: vi.fn(() => ({ llm: { provider: "openai" } })),
      get: vi.fn((key?: string) => {
        if (key === "marketplace") return { installedProviderIds: [] as string[] };
        if (key === "shortcuts") return {};
        if (key === "system") return {};
        return { provider: "openai", vendors: { openai: { baseUrl: null } } };
      }),
      getSecret: vi.fn(() => null),
    },
    conversationLoop: { refreshProvider: vi.fn() },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => []),
    singleHopNetworkFetch,
  };
}

beforeEach(() => {
  handlers.clear();
  listLlmModelsFromSettingsMock.mockReset();
  listLlmModelsFromSettingsMock.mockResolvedValue({
    ok: true,
    models: [],
    endpoint: "",
    fetchedAt: "",
  });
  vi.resetModules();
});

describe("model list IPC transport injection", () => {
  it("passes the host transport into the engine as fetchImpl", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    const singleHopNetworkFetch = vi.fn() as unknown as typeof fetch;
    registerSettingsHandlers(makeDeps(singleHopNetworkFetch) as never);

    await invoke(CHANNELS.settings.listLlmModels, { vendor: "openai" });

    expect(listLlmModelsFromSettingsMock).toHaveBeenCalledOnce();
    const options = listLlmModelsFromSettingsMock.mock.calls[0]?.[2] as
      | { fetchImpl?: unknown }
      | undefined;
    expect(options?.fetchImpl).toBe(singleHopNetworkFetch);
  });

  it("never leaves the engine to pick up the ambient fetch", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    const singleHopNetworkFetch = vi.fn() as unknown as typeof fetch;
    registerSettingsHandlers(makeDeps(singleHopNetworkFetch) as never);

    await invoke(CHANNELS.settings.listLlmModels, { vendor: "openai" });

    const options = listLlmModelsFromSettingsMock.mock.calls[0]?.[2] as
      | { fetchImpl?: unknown }
      | undefined;
    expect(options?.fetchImpl).toBeDefined();
    expect(options?.fetchImpl).not.toBe(globalThis.fetch);
  });
});
