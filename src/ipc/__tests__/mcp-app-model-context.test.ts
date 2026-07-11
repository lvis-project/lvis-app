/**
 * `lvis:mcp:ui-model-context` — the gated IPC behind the MCP-app `onupdatemodelcontext`
 * handler.
 *
 * The three things asserted here and nowhere else:
 *   1. An UNAUTHORIZED sender is refused (it mutates what the model reads next turn).
 *   2. It NEVER touches the conversation loop — no turn, no guidance, no follow-up.
 *   3. A card whose session is no longer the live one is DROPPED (fail-safe), the same
 *      rule `ui/message` applies.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { tmpdir } from "node:os";
import { CHANNELS } from "../../contract/app-contract.js";
import { McpAppModelContextStore } from "../../mcp/mcp-app-model-context.js";

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handleMap.set(channel, fn);
    }),
  },
  dialog: { showSaveDialog: vi.fn() },
  webContents: { getAllWebContents: () => [] },
  app: { getPath: () => tmpdir(), getVersion: () => "0.0.0-test" },
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
}));

function hostEvent(): IpcMainInvokeEvent {
  return {
    senderFrame: { url: "file:///Applications/Lvis.app/dist/index.html" },
    sender: {},
  } as unknown as IpcMainInvokeEvent;
}

function foreignEvent(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url }, sender: {} } as unknown as IpcMainInvokeEvent;
}

const ACTIVE_SESSION = "session-live";

/** Every mutating conversation entry point — none of them may be reachable from here. */
const loopSpies = {
  queueGuidance: vi.fn(),
  sendMessage: vi.fn(),
  processInput: vi.fn(),
};

let mcpAppModelContext: McpAppModelContextStore;

function makeDeps() {
  return {
    auditLogger: { log: vi.fn() },
    getMainWindow: () => null,
    mcpAppModelContext,
    conversationLoop: { getSessionId: () => ACTIVE_SESSION, ...loopSpies },
    pluginRuntime: { on: vi.fn(), listPluginCards: () => [], getMethodOwner: () => undefined },
    pluginMarketplace: { list: async () => [], getFetcher: () => ({}) },
    settingsService: { get: () => ({}), getSettings: () => ({}) },
    mcpManager: { readUiResource: vi.fn(), namespacedToolName: vi.fn(), listServers: () => [] },
    pluginLoopbackManager: { has: () => false, readUiResource: vi.fn() },
    toolRegistry: { findByName: () => undefined },
    getPluginToolInvoker: () => null,
    notificationService: { fire: vi.fn() },
  } as unknown as import("../types.js").IpcDeps;
}

const params = { content: [{ type: "text", text: "cart: 3 items" }] };

describe("lvis:mcp:ui-model-context", () => {
  let invoke: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

  beforeEach(async () => {
    handleMap.clear();
    for (const spy of Object.values(loopSpies)) spy.mockClear();
    mcpAppModelContext = new McpAppModelContextStore();
    vi.resetModules();
    const { registerPluginsHandlers } = await import("../domains/plugins.js?t=" + Date.now());
    registerPluginsHandlers(makeDeps());
    invoke = handleMap.get(CHANNELS.mcp.uiModelContext)!;
    expect(invoke).toBeTypeOf("function");
  });

  it("REFUSES an unauthorized sender", async () => {
    for (const url of ["https://evil.example/index.html", "", "lvis-plugin://shell/index.html"]) {
      const result = await invoke(foreignEvent(url), "github", ACTIVE_SESSION, "card-1", params);

      expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    }
    expect(mcpAppModelContext.size()).toBe(0);
  });

  it("stores the card's context — and NEVER starts a turn", async () => {
    const result = await invoke(hostEvent(), "github", ACTIVE_SESSION, "card-1", params);

    expect(result).toEqual({ ok: true, disposition: "stored" });
    expect(mcpAppModelContext.buildSection(ACTIVE_SESSION)).toContain("cart: 3 items");
    // The whole point of the seam: no path from here into the conversation loop.
    expect(loopSpies.queueGuidance).not.toHaveBeenCalled();
    expect(loopSpies.sendMessage).not.toHaveBeenCalled();
    expect(loopSpies.processInput).not.toHaveBeenCalled();
  });

  it("OVERWRITES on the second call rather than appending", async () => {
    await invoke(hostEvent(), "github", ACTIVE_SESSION, "card-1", params);
    await invoke(hostEvent(), "github", ACTIVE_SESSION, "card-1", {
      content: [{ type: "text", text: "cart: 5 items" }],
    });

    const section = mcpAppModelContext.buildSection(ACTIVE_SESSION);
    expect(section).toContain("cart: 5 items");
    expect(section).not.toContain("cart: 3 items");
    expect(mcpAppModelContext.size()).toBe(1);
  });

  it("DROPS a card whose session is no longer the live conversation", async () => {
    const result = await invoke(hostEvent(), "github", "session-the-user-left", "card-1", params);

    expect(result).toMatchObject({ ok: false, error: "session-mismatch" });
    expect(mcpAppModelContext.size()).toBe(0);
  });

  it("refuses an over-cap body without disturbing what the card already stored", async () => {
    await invoke(hostEvent(), "github", ACTIVE_SESSION, "card-1", params);

    const result = await invoke(hostEvent(), "github", ACTIVE_SESSION, "card-1", {
      content: [{ type: "text", text: "x".repeat(100_000) }],
    });

    expect(result).toMatchObject({ ok: false, error: "too-large" });
    expect(mcpAppModelContext.buildSection(ACTIVE_SESSION)).toContain("cart: 3 items");
  });
});
