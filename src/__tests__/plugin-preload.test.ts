/**
 * #237 Option B — Plugin Preload Bridge Security Tests
 *
 * Verifies that the plugin webview preload (plugin-preload.ts) exposes ONLY
 * the narrow `window.lvisPlugin` bridge and does NOT leak any host-level APIs
 * (`window.lvisApi`, `window.lvisHost`, `window.lvis`).
 *
 * We load the preload once and capture its contextBridge registrations.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";

// ─── Capture contextBridge registrations ─────────────────────────────────────

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

// Plugin preload uses NAMED imports
// (`import { contextBridge, ipcRenderer } from "electron"`) so esbuild
// bundles them as `require("electron").contextBridge` directly — no
// `__toESM` wrapper, no `.default` indirection. The mock therefore exposes
// `contextBridge` and `ipcRenderer` as named exports.
// Named exports only — no `default` wrapper. A regression to the old
// `import electron from "electron"` default-import pattern will fail here
// because the mock no longer supplies a `.default` object.
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
  return {
    contextBridge,
    ipcRenderer,
  };
});

// Load the preload module once — top-level code executes once per module instance.
beforeAll(async () => {
  await import("../plugin-preload.js");
});

// ─── Positive / negative contract tests ───────────────────────────────────────

describe("plugin-preload bridge", () => {
  it("exposes window.lvisPlugin with callTool, emitEvent, onEvent", () => {
    expect(exposed.has("lvisPlugin")).toBe(true);
    const bridge = exposed.get("lvisPlugin") as Record<string, unknown>;
    expect(typeof bridge.callTool).toBe("function");
    expect(typeof bridge.emitEvent).toBe("function");
    expect(typeof bridge.onEvent).toBe("function");
  });

  it("does NOT expose window.lvisApi (host-level API)", () => {
    expect(exposed.has("lvisApi")).toBe(false);
  });

  it("does NOT expose window.lvisHost (marketplace install API)", () => {
    expect(exposed.has("lvisHost")).toBe(false);
  });

  it("does NOT expose window.lvis (host namespace)", () => {
    expect(exposed.has("lvis")).toBe(false);
  });

  it("callTool invokes lvis:plugin:call-tool IPC channel without pluginId arg", async () => {
    // pluginId is now resolved by main from event.sender.id, NOT supplied
    // by the renderer — the bridge MUST NOT pass it.
    const bridge = exposed.get("lvisPlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: true, result: "pong" });

    await bridge.callTool("agent_hub_status", { verbose: true });

    expect(mockInvoke).toHaveBeenCalledWith(
      "lvis:plugin:call-tool",
      "agent_hub_status",
      { verbose: true },
    );
  });

  it("callTool unwraps { ok: true, result } and resolves to the raw result", async () => {
    const bridge = exposed.get("lvisPlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: true, result: { authenticated: true, cookieCount: 7 } });

    const value = await bridge.callTool("status", {});
    expect(value).toEqual({ authenticated: true, cookieCount: 7 });
  });

  it("callTool throws Error(message) when host returns { ok: false, error }", async () => {
    const bridge = exposed.get("lvisPlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "cross-plugin-call-denied" });

    await expect(bridge.callTool("forbidden_tool", {})).rejects.toThrow(/cross-plugin-call-denied/);
  });

  it("callTool passes through non-envelope replies verbatim (forward compat)", async () => {
    // Tolerates a future host change that emits raw values directly.
    const bridge = exposed.get("lvisPlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ authenticated: true });

    expect(await bridge.callTool("status", {})).toEqual({ authenticated: true });
  });

  it("emitEvent invokes lvis:plugin:emit-event IPC channel without pluginId arg", async () => {
    const bridge = exposed.get("lvisPlugin") as { emitEvent: (type: string, data?: unknown) => Promise<void> };
    mockInvoke.mockResolvedValueOnce({ ok: true });

    const value = await bridge.emitEvent("my.custom.event", { foo: "bar" });

    expect(mockInvoke).toHaveBeenCalledWith(
      "lvis:plugin:emit-event",
      "my.custom.event",
      { foo: "bar" },
    );
    // Lock the Promise<void> contract — emitEvent success resolves to undefined,
    // not the host's `{ok:true}` envelope.
    expect(value).toBeUndefined();
  });

  it("callTool resolves to undefined when host returns { ok: true } with no result field", async () => {
    // Symmetric to emitEvent — a fire-and-forget tool that succeeds with no
    // payload should resolve to undefined, not the envelope.
    const bridge = exposed.get("lvisPlugin") as { callTool: (name: string, args?: unknown) => Promise<unknown> };
    mockInvoke.mockResolvedValueOnce({ ok: true });

    expect(await bridge.callTool("fire_and_forget", {})).toBeUndefined();
  });

  it("emitEvent throws Error(message) when host returns { ok: false, error }", async () => {
    const bridge = exposed.get("lvisPlugin") as { emitEvent: (type: string, data?: unknown) => Promise<void> };
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "missing-capability:event-emit" });

    await expect(bridge.emitEvent("forbidden.event", {})).rejects.toThrow(/missing-capability/);
  });

  it("getEntryUrl invokes lvis:plugin:get-entry-url and unwraps the success sentinel", async () => {
    const bridge = exposed.get("lvisPlugin") as { getEntryUrl: () => Promise<string> };
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      entryUrl: "file:///plugins/agent-hub/dist/ui/agent-hub-panel.js",
    });

    const url = await bridge.getEntryUrl();

    expect(mockInvoke).toHaveBeenCalledWith("lvis:plugin:get-entry-url");
    expect(url).toBe("file:///plugins/agent-hub/dist/ui/agent-hub-panel.js");
  });

  it("getEntryUrl throws when main returns a rejection sentinel", async () => {
    const bridge = exposed.get("lvisPlugin") as { getEntryUrl: () => Promise<string> };
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "unauthorized-frame" });

    await expect(bridge.getEntryUrl()).rejects.toThrow(/unauthorized-frame/);
  });

  // Issue #439: registration-timeout is a recoverable variant the shell can
  // retry. Both error codes flow through the same throw path, but the message
  // text must be preserved so the shell's retry filter sees the right code.
  it("getEntryUrl surfaces the registration-timeout error verbatim", async () => {
    const bridge = exposed.get("lvisPlugin") as { getEntryUrl: () => Promise<string> };
    mockInvoke.mockResolvedValueOnce({ ok: false, error: "registration-timeout" });

    await expect(bridge.getEntryUrl()).rejects.toThrow(/registration-timeout/);
  });

  it("onEvent registers listener on lvis:plugin:event IPC channel and returns unsubscribe", () => {
    const bridge = exposed.get("lvisPlugin") as {
      onEvent: (type: string, handler: (data: unknown) => void) => () => void;
    };

    const handler = vi.fn();
    const unsubscribe = bridge.onEvent("meeting.started", handler);

    expect(mockOn).toHaveBeenCalledWith("lvis:plugin:event", expect.any(Function));
    expect(typeof unsubscribe).toBe("function");

    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith("lvis:plugin:event", expect.any(Function));
  });

  it("lifecycle APIs absent: getRuntimeCounts, pingMarketplace, onPluginInstallResult not callable", () => {
    const bridge = exposed.get("lvisPlugin") as Record<string, unknown>;

    expect(bridge).not.toHaveProperty("getRuntimeCounts");
    expect(bridge).not.toHaveProperty("pingMarketplace");
    expect(bridge).not.toHaveProperty("getRuntimeEnv");
    expect(bridge).not.toHaveProperty("onPluginInstallResult");
    expect(bridge).not.toHaveProperty("onPluginUninstallResult");
    expect(bridge).not.toHaveProperty("onPluginInstallProgress");
  });
});
