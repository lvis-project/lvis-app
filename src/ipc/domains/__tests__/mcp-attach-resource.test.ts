/**
 * `lvis:mcp:attach-resource` — the user path's IPC.
 *
 * What this channel must guarantee:
 *   - an unauthorized sender frame is rejected BEFORE anything reaches a server
 *   - the HOST builds the fence; the renderer receives a ready-to-attach part and
 *     assembles nothing, because server text lands beside the user's own words
 *   - it never starts a turn: the outcome is an attachment the renderer must send
 *   - a URI shape the host would not catalogue is refused before the request
 *   - failures fail closed with a sanitized code (no server message, no host path)
 *   - per-server rate limiting applies (it reaches a server on the user's behalf)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  webContents: { fromId: vi.fn() },
}));

const CHANNEL = "lvis:mcp:attach-resource";
const invoke = makeAppIpcInvoker(handlers);

async function setup(readDeclaredResource?: ReturnType<typeof vi.fn>) {
  handlers.clear();
  vi.clearAllMocks();
  // Fresh serverId per test — the rate limiter is a module singleton.
  const serverId = `hr-mcp-${Math.random().toString(36).slice(2, 10)}`;
  const readMock =
    readDeclaredResource ??
    vi.fn(async () => ({
      blocks: [{ uri: "file:///policy.md", mimeType: "text/markdown", text: "POLICY BODY" }],
      droppedBlocks: 0,
      truncated: false,
    }));

  const deps = {
    pluginRuntime: { getPerfStats: vi.fn(() => ({})) },
    pluginLoopbackManager: { has: vi.fn(() => true), readUiResource: vi.fn() },
    mcpManager: {
      readUiResource: vi.fn(),
      listServers: vi.fn(() => []),
      listDeclaredResources: vi.fn(() => []),
      namespacedToolName: vi.fn(),
      getPrompt: vi.fn(),
      readDeclaredResource: readMock,
    },
    toolRegistry: { size: 0, findByName: vi.fn() },
    getPluginToolInvoker: () => vi.fn(),
    settingsService: { get: vi.fn(() => ({})) },
    auditLogger: { log: vi.fn() },
    pluginMarketplace: { list: vi.fn(async () => []) },
    refreshPluginNotifications: vi.fn(),
    conversationLoop: { getSessionId: vi.fn(() => "session-live"), queueGuidance: vi.fn() },
    notificationService: { fire: vi.fn() },
    getMainWindow: vi.fn(() => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: vi.fn() },
    })),
    getAppWindows: vi.fn(() => []),
  };

  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return { deps, serverId, readMock };
}

beforeEach(() => {
  handlers.clear();
});

describe("lvis:mcp:attach-resource — sender gate", () => {
  it("rejects an unauthorized sender frame before reaching the server", async () => {
    const { serverId, readMock } = await setup();
    const handler = handlers.get(CHANNEL)!;
    const result = await handler(
      { senderFrame: { url: "https://evil.example.com/x" } } as never,
      serverId,
      "file:///policy.md",
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(readMock).not.toHaveBeenCalled();
  });
});

describe("lvis:mcp:attach-resource — outcome", () => {
  it("returns a host-built fenced attachment, ready to send verbatim", async () => {
    const { serverId, readMock } = await setup();
    const result = (await invoke(CHANNEL, serverId, "file:///policy.md")) as {
      ok: boolean;
      attachment: { type: string; text: string };
    };
    expect(result.ok).toBe(true);
    expect(result.attachment.type).toBe("text");
    // The renderer assembles nothing: the fence, the untrusted framing, and the
    // provenance are all in the string the host returned.
    expect(result.attachment.text.startsWith('<mcp-resource trust="untrusted-server-data"')).toBe(true);
    expect(result.attachment.text).toContain(`server="${serverId}"`);
    expect(result.attachment.text).toContain("POLICY BODY");
    expect(result.attachment.text.endsWith("</mcp-resource>")).toBe(true);
    expect(readMock).toHaveBeenCalledWith(serverId, "file:///policy.md");
  });

  it("refuses a URI shape the host would never catalogue, before any request", async () => {
    const { serverId, readMock } = await setup();
    for (const uri of [
      "ui://widget/main.html", // the MCP-Apps serving path — different containment
      "javascript:alert(1)",
      "no-scheme",
      "",
      42,
    ]) {
      const result = await invoke(CHANNEL, serverId, uri);
      expect(result, String(uri).slice(0, 32)).toEqual({ ok: false, error: "invalid-request" });
    }
    expect(readMock).not.toHaveBeenCalled();
  });

  // Shape-checked BEFORE the rate bucket and the audit line, as `getPrompt` does: an
  // unbounded serverId becomes a permanent key in a shared limiter map and lands
  // un-sliced in audit rows.
  it("refuses a serverId that cannot be a server id", async () => {
    const { readMock } = await setup();
    for (const bad of ["bad id with spaces", "s".repeat(500), "-leading-dash", ""]) {
      const result = await invoke(CHANNEL, bad, "file:///policy.md");
      expect(result, bad.slice(0, 24)).toEqual({ ok: false, error: "invalid-server-id" });
    }
    expect(readMock).not.toHaveBeenCalled();
  });

  it("fails closed on an empty render and on a server error", async () => {
    const empty = await setup(vi.fn(async () => ({ blocks: [], droppedBlocks: 0, truncated: false })));
    expect(await invoke(CHANNEL, empty.serverId, "file:///x")).toEqual({
      ok: false,
      error: "empty-resource",
    });

    const boom = await setup(
      vi.fn(async () => {
        throw new Error("ENOENT: C:/Users/secret/path leaked");
      }),
    );
    const failed = (await invoke(CHANNEL, boom.serverId, "file:///x")) as { ok: boolean; error: string };
    expect(failed).toEqual({ ok: false, error: "resource-failed" });
    // The server's message never reaches the renderer.
    expect(JSON.stringify(failed)).not.toContain("secret");
  });

  it("reports a clip rather than presenting a partial resource as whole", async () => {
    const { serverId } = await setup(
      vi.fn(async () => ({
        blocks: [{ text: "HEAD" }, { omittedKind: "binary" }],
        droppedBlocks: 3,
        truncated: true,
      })),
    );
    const result = (await invoke(CHANNEL, serverId, "file:///x")) as {
      truncated: boolean;
      omittedBlocks: number;
    };
    expect(result.truncated).toBe(true);
    expect(result.omittedBlocks).toBe(1);
  });

  it("rate limits per server", async () => {
    const { serverId } = await setup();
    let limited = false;
    for (let i = 0; i < 40; i += 1) {
      const result = (await invoke(CHANNEL, serverId, "file:///x")) as { error?: string };
      if (result.error === "rate-limited") {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});
