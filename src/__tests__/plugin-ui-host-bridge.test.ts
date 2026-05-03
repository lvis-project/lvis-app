/**
 * #B1 — `bridge.config` + `bridge.storage` round-trip contract.
 *
 * Verifies that the plugin webview preload's namespaced bridge:
 *   - exposes `config.{get,set}` and `storage.{get,set}` on `window.lvisPlugin`
 *   - routes each through its dedicated IPC channel (no dotted-name silent fail)
 *   - resolves to the unwrapped `value` on `{ ok: true, value }`
 *   - resolves to `undefined` on `{ ok: true }` / `{ ok: true, value: undefined }`
 *   - rejects with `Error(error)` on `{ ok: false, error }`
 *
 * Pre-#B1, plugin UI code that called `bridge.callTool("hostApi.config.get", …)`
 * silently failed: the dotted-name format is rejected by every supported LLM
 * provider's tool-name regex, AND no host dispatcher routed it. This test
 * locks the new dedicated-channel contract so a regression to the dotted name
 * cannot reintroduce that silent-fail.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";

// ─── Capture contextBridge registrations ─────────────────────────────────────

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

// Plugin preload uses NAMED imports — see plugin-preload.test.ts for the
// reasoning. Mock matches that contract.
vi.mock("electron", () => {
  const contextBridge = {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value);
    },
  };
  const ipcRenderer = {
    invoke: (...args: unknown[]) => mockInvoke(...args),
    on: (...args: unknown[]) => mockOn(...args),
    removeListener: (...args: unknown[]) => mockRemoveListener(...args),
  };
  return { contextBridge, ipcRenderer };
});

beforeAll(async () => {
  await import("../plugin-preload.js");
});

type ConfigBridge = {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
};
type StorageBridge = {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
};

function getConfig(): ConfigBridge {
  const bridge = exposed.get("lvisPlugin") as Record<string, unknown>;
  return bridge.config as ConfigBridge;
}
function getStorage(): StorageBridge {
  const bridge = exposed.get("lvisPlugin") as Record<string, unknown>;
  return bridge.storage as StorageBridge;
}

describe("plugin-preload bridge.config namespace (#B1)", () => {
  it("exposes config.{get,set} as functions", () => {
    const config = getConfig();
    expect(typeof config.get).toBe("function");
    expect(typeof config.set).toBe("function");
  });

  it("config.get invokes lvis:plugin:config:get and unwraps `value`", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: "subscribed-team-7" });
    const config = getConfig();

    const value = await config.get<string>("defaultTeam");

    expect(mockInvoke).toHaveBeenCalledWith("lvis:plugin:config:get", "defaultTeam");
    expect(value).toBe("subscribed-team-7");
  });

  it("config.get resolves to undefined when host returns `value: undefined`", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: undefined });
    const config = getConfig();

    expect(await config.get("missingKey")).toBeUndefined();
  });

  it("config.set invokes lvis:plugin:config:set with key + value", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true });
    const config = getConfig();

    await config.set("defaultTeam", "ai-platform");

    expect(mockInvoke).toHaveBeenCalledWith(
      "lvis:plugin:config:set",
      "defaultTeam",
      "ai-platform",
    );
  });

  it("config.get throws Error(error) when host returns ok=false", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "invalid-key" });
    const config = getConfig();

    await expect(config.get("")).rejects.toThrow(/invalid-key/);
  });

  it("config.set throws Error(error) when host returns ok=false", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "unauthorized-frame" });
    const config = getConfig();

    await expect(config.set("k", "v")).rejects.toThrow(/unauthorized-frame/);
  });

  it("does NOT route through callTool with dotted name (C2 regression guard)", async () => {
    // Pre-#B1, plugin code called `bridge.callTool("hostApi.config.get", …)`
    // which silently failed (dotted name banned by tool-name regex + no
    // dispatcher). The fix uses dedicated `lvis:plugin:config:*` channels.
    // Lock that contract: the channel name must NOT contain "callTool",
    // "hostApi.", or any dotted method name.
    mockInvoke.mockResolvedValueOnce({ ok: true, value: 1 });
    await getConfig().get("k");
    const channel = mockInvoke.mock.calls.at(-1)?.[0] as string;
    expect(channel).toBe("lvis:plugin:config:get");
    expect(channel).not.toMatch(/callTool|hostApi\./);
  });
});

describe("plugin-preload bridge.storage namespace (#B1)", () => {
  it("exposes storage.{get,set} as functions", () => {
    const storage = getStorage();
    expect(typeof storage.get).toBe("function");
    expect(typeof storage.set).toBe("function");
  });

  it("storage.get invokes lvis:plugin:storage:get and unwraps `value`", async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      value: { lastViewedTab: "team-board" },
    });
    const storage = getStorage();

    const value = await storage.get<{ lastViewedTab: string }>("uiState");

    expect(mockInvoke).toHaveBeenCalledWith("lvis:plugin:storage:get", "uiState");
    expect(value).toEqual({ lastViewedTab: "team-board" });
  });

  it("storage.set invokes lvis:plugin:storage:set with key + value", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true });
    const storage = getStorage();

    await storage.set("uiState", { lastViewedTab: "my-work" });

    expect(mockInvoke).toHaveBeenCalledWith(
      "lvis:plugin:storage:set",
      "uiState",
      { lastViewedTab: "my-work" },
    );
  });

  it("storage.get throws Error(error) when host returns ok=false", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "unknown-plugin-id" });
    const storage = getStorage();

    await expect(storage.get("k")).rejects.toThrow(/unknown-plugin-id/);
  });

  it("storage.set throws Error(error) on invalid-key sentinel", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "invalid-key" });
    const storage = getStorage();

    await expect(storage.set("../escape", "x")).rejects.toThrow(/invalid-key/);
  });

  it("does NOT route through callTool with dotted name (C2 regression guard)", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: 1 });
    await getStorage().get("k");
    const channel = mockInvoke.mock.calls.at(-1)?.[0] as string;
    expect(channel).toBe("lvis:plugin:storage:get");
    expect(channel).not.toMatch(/callTool|hostApi\./);
  });
});
