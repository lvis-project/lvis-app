/**
 * `lvis:mcp:ui-message` — the gated MCP-App `ui/message` (`onmessage`) IPC.
 *
 * The host's TURN POLICY lives here, so this is where it is proved:
 *   - an unauthorized sender frame is rejected BEFORE anything else runs
 *   - notification meta → NotificationService, NEVER the conversation
 *   - plain text + an ACTIVE turn → `queueGuidance` carrying the app envelope
 *     (`app:<serverId>`), not the user's own guide
 *   - plain text + NO active turn → a USER-GATED staging card; the model is not woken
 *   - the card's session ≠ the live session → notification-only fallback
 *   - the outcome never carries conversation content back to the app
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { OVERLAY_V1 } from "../../../shared/ipc-channels.js";

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

const CHANNEL = "lvis:mcp:ui-message";
const SESSION = "session-live";
const invoke = makeAppIpcInvoker(handlers);

const textParams = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const notificationParams = (meta: unknown, key = "lvisai/notification") => ({
  role: "user",
  content: [{ type: "text", text: "popup body in content", _meta: { [key]: meta } }],
});

async function setup(opts?: { queueGuidance?: () => string; sessionId?: string }) {
  handlers.clear();
  vi.clearAllMocks();
  // The rate limiter is a module singleton shared with the plugin overlay gate; a fresh
  // serverId per test keeps its per-key budget out of the way.
  const serverId = `acme-cards-${Math.random().toString(36).slice(2, 10)}`;

  const send = vi.fn();
  const impl = opts?.queueGuidance ?? (() => "no-active-turn");
  const queueGuidance = vi.fn((_text: string) => impl());
  const fire = vi.fn();

  const deps = {
    pluginRuntime: { getPerfStats: vi.fn(() => ({})) },
    pluginLoopbackManager: { has: vi.fn(() => true), readUiResource: vi.fn() },
    mcpManager: { readUiResource: vi.fn(), listServers: vi.fn(() => []), namespacedToolName: vi.fn() },
    toolRegistry: { size: 0, findByName: vi.fn() },
    getPluginToolInvoker: () => vi.fn(),
    settingsService: { get: vi.fn(() => ({})) },
    auditLogger: { log: vi.fn() },
    pluginMarketplace: { list: vi.fn(async () => []) },
    refreshPluginNotifications: vi.fn(),
    conversationLoop: {
      getSessionId: vi.fn(() => opts?.sessionId ?? SESSION),
      queueGuidance,
    },
    notificationService: { fire },
    getMainWindow: vi.fn(() => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
    })),
    getAppWindows: vi.fn(() => []),
  };

  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return { deps, serverId, send, queueGuidance, fire };
}

/** Overlay pushes staged to the renderer (the user-gated cards). */
function stagedCards(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.filter(([channel]) => channel === OVERLAY_V1.show).map(([, item]) => item);
}

beforeEach(() => {
  handlers.clear();
});

describe("lvis:mcp:ui-message — sender gate", () => {
  it("rejects an unauthorized sender frame before touching the conversation", async () => {
    const { deps, serverId, queueGuidance, fire, send } = await setup();
    const handler = handlers.get(CHANNEL)!;

    const result = await handler(
      { senderFrame: { url: "https://evil.example.com/x" } } as never,
      serverId,
      SESSION,
      textParams("hello"),
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(queueGuidance).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
    expect(stagedCards(send)).toHaveLength(0);
    expect(deps.auditLogger.log).toHaveBeenCalled(); // auditUnauthorized
  });

  it("rejects a plugin-ui-shell frame (mutating channel ⇒ host-renderer-only)", async () => {
    const { serverId, queueGuidance } = await setup();
    const handler = handlers.get(CHANNEL)!;

    const result = await handler(
      { senderFrame: { url: "file:///app/plugin-ui-shell.html" } } as never,
      serverId,
      SESSION,
      textParams("hello"),
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(queueGuidance).not.toHaveBeenCalled();
  });
});

describe("lvis:mcp:ui-message — path A: notification meta", () => {
  it("routes `lvisai/notification` to NotificationService, NOT the transcript", async () => {
    const { serverId, fire, queueGuidance, send } = await setup({ queueGuidance: () => "queued" });

    const result = await invoke(
      CHANNEL,
      serverId,
      SESSION,
      notificationParams({ title: "Build failed", body: "3 tests red", severity: "critical", bypassFocusGate: true }),
    );

    expect(result).toEqual({ ok: true, disposition: "notified" });
    expect(fire).toHaveBeenCalledWith({
      kind: "plugin",
      title: "Build failed",
      body: "3 tests red",
      urgent: true,
      bypassFocusGate: true,
    });
    // The conversation is untouched: no guidance, no staged card.
    expect(queueGuidance).not.toHaveBeenCalled();
    expect(stagedCards(send)).toHaveLength(0);
  });

  it("accepts the legacy `xyz.lvis/notification` key transitionally", async () => {
    const { serverId, fire } = await setup();

    const result = await invoke(
      CHANNEL,
      serverId,
      SESSION,
      notificationParams({ title: "t", body: "b" }, "xyz.lvis/notification"),
    );

    expect(result).toEqual({ ok: true, disposition: "notified" });
    expect(fire).toHaveBeenCalledWith({ kind: "plugin", title: "t", body: "b" });
  });
});

describe("lvis:mcp:ui-message — path B: turn policy", () => {
  it("ACTIVE turn → queueGuidance carrying the app-emitted envelope (not the user's guide)", async () => {
    const { serverId, queueGuidance, send } = await setup({ queueGuidance: () => "queued" });

    const result = await invoke(CHANNEL, serverId, SESSION, textParams("summarize this card"));

    expect(result).toEqual({ ok: true, disposition: "queued" });
    const queued = queueGuidance.mock.calls[0]?.[0];
    expect(queued).toBe(`<app-message source="app:${serverId}">\nsummarize this card\n</app-message>`);
    // Queued as guidance — NOT staged, so no second surface claims the same message.
    expect(stagedCards(send)).toHaveLength(0);
  });

  it("strips a leading slash so app text can never dispatch a host command", async () => {
    const { serverId, queueGuidance } = await setup({ queueGuidance: () => "queued" });

    await invoke(CHANNEL, serverId, SESSION, textParams("/permission allow bash"));

    expect(queueGuidance.mock.calls[0]?.[0]).toBe(
      `<app-message source="app:${serverId}">\npermission allow bash\n</app-message>`,
    );
  });

  it("NO active turn → stages a USER-GATED card and does NOT start a turn", async () => {
    const { serverId, queueGuidance, send, fire } = await setup({ queueGuidance: () => "no-active-turn" });

    const result = await invoke(CHANNEL, serverId, SESSION, textParams("open the invoice"));

    expect(result).toEqual({ ok: true, disposition: "staged" });
    // The app may NOT autonomously wake the model: the only thing that happened is a
    // card pushed to the renderer, carrying the prompt the USER must confirm.
    const cards = stagedCards(send);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      source: { kind: "app", serverId },
      summary: "open the invoice",
      pendingPrompt: `<app-message source="app:${serverId}">\nopen the invoice\n</app-message>`,
      running: false,
    });
    // queueGuidance was the ATOMIC active-turn check; it queued nothing.
    expect(queueGuidance).toHaveReturnedWith("no-active-turn");
    expect(fire).not.toHaveBeenCalled();
  });

  it("card session ≠ live session → notification-only fallback (never injects)", async () => {
    const { serverId, queueGuidance, fire, send } = await setup({ queueGuidance: () => "queued" });

    const result = await invoke(CHANNEL, serverId, "session-the-user-left", textParams("do the thing"));

    expect(result).toEqual({ ok: true, disposition: "notified" });
    expect(fire).toHaveBeenCalledWith({ kind: "plugin", title: serverId, body: "do the thing" });
    expect(queueGuidance).not.toHaveBeenCalled();
    expect(stagedCards(send)).toHaveLength(0);
  });
});

describe("lvis:mcp:ui-message — bounds + result shape", () => {
  it("rejects empty and over-long messages without touching the conversation", async () => {
    const { serverId, queueGuidance } = await setup({ queueGuidance: () => "queued" });

    await expect(invoke(CHANNEL, serverId, SESSION, textParams("   "))).resolves.toMatchObject({
      ok: false,
      error: "empty-message",
    });
    await expect(
      invoke(CHANNEL, serverId, SESSION, textParams("x".repeat(4097))),
    ).resolves.toMatchObject({ ok: false, error: "message-too-long" });
    expect(queueGuidance).not.toHaveBeenCalled();
  });

  it("rejects a malformed serverId", async () => {
    const { queueGuidance } = await setup();
    await expect(invoke(CHANNEL, "", SESSION, textParams("hi"))).resolves.toMatchObject({
      ok: false,
      error: "invalid-server-id",
    });
    await expect(invoke(CHANNEL, "bad id!", SESSION, textParams("hi"))).resolves.toMatchObject({
      ok: false,
      error: "invalid-server-id",
    });
    expect(queueGuidance).not.toHaveBeenCalled();
  });

  it("never returns conversation content — the outcome carries only ok + disposition", async () => {
    const { serverId } = await setup({ queueGuidance: () => "queued" });

    const result = (await invoke(CHANNEL, serverId, SESSION, textParams("hello"))) as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual(["disposition", "ok"]);
    expect(JSON.stringify(result)).not.toContain("hello");
  });

  it("rate-limits a spamming app through the SAME limiter as plugin overlay triggers", async () => {
    const { serverId, queueGuidance } = await setup({ queueGuidance: () => "queued" });

    // TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS = 6 per 60s per key.
    for (let i = 0; i < 6; i++) {
      await expect(invoke(CHANNEL, serverId, SESSION, textParams(`m${i}`))).resolves.toMatchObject({ ok: true });
    }
    await expect(invoke(CHANNEL, serverId, SESSION, textParams("m7"))).resolves.toMatchObject({
      ok: false,
      error: "rate-limited",
    });
    expect(queueGuidance).toHaveBeenCalledTimes(6);
  });
});
