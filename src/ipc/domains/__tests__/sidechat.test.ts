/**
 * Side-chat IPC domain — engine isolation + trust boundary.
 *
 * Asserts the load-bearing guarantees of the companion PR:
 *   1. send drives the SIDE-CHAT loop (never the main loop) and publishes its
 *      stream frames to the DEDICATED `lvis:sidechat:stream` channel — never
 *      `lvis:chat:stream` (main/side stream isolation).
 *   2. abort aborts the SIDE-CHAT loop only.
 *   3. every mutating channel rejects an unauthorized frame.
 *   4. when the side-chat loop is absent, handlers fail closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import {
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
  MCP_RESOURCE_FENCE_OPEN,
} from "../../../shared/mcp-resource-bounds.js";

/** A real 1×1 PNG: the image normalizer decodes and sniffs the bytes. */
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

// Capture every (channel, payload) the domain publishes so we can assert the
// stream fan-out lands on the dedicated side-chat channel.
const sent: Array<{ channel: string; payload: unknown }> = [];
vi.mock("../../safe-send.js", () => ({
  sendToWebContents: vi.fn((_wc: unknown, channel: string, payload: unknown) => {
    sent.push({ channel, payload });
  }),
}));

import { registerSideChatHandlers } from "../sidechat.js";
import { CHANNELS } from "../../../contract/app-contract.js";

function ev(url?: string): IpcMainInvokeEvent {
  return (url ? { senderFrame: { url } } : {}) as unknown as IpcMainInvokeEvent;
}

function makeSideLoop() {
  return {
    // runTurn emits one text delta + a done frame through the injected callbacks
    // so the stream sink is exercised, then resolves the TurnResult.
    runTurn: vi.fn(async (_input: string, callbacks: Record<string, (...a: unknown[]) => void>) => {
      callbacks.onTextDelta?.("hi");
      return { route: "chat" };
    }),
    newConversation: vi.fn(),
    loadSession: vi.fn(() => true),
    getSessionId: vi.fn(() => "34fd6270-309d-4e47-878b-75c0742a6ac2"),
    getHistory: vi.fn(() => ({ getMessages: vi.fn(() => []) })),
    listSessions: vi.fn(() => []),
    abortCurrentTurn: vi.fn(),
  };
}

function makeMainLoop() {
  return {
    runTurn: vi.fn(),
    abortCurrentTurn: vi.fn(),
    getSessionId: vi.fn(() => "89df5053-7dd8-4550-85c5-1a11011f7868"),
  };
}

function register(sideLoop: unknown, mainLoop: unknown, piiRedactEnabled = false) {
  const deps = {
    conversationLoop: mainLoop,
    sideChatConversationLoop: sideLoop,
    auditLogger: { log: vi.fn() },
    getMainWindow: () => ({ webContents: {} }),
    settingsService: {
      get: vi.fn((key: string) => (key === "privacy" ? { piiRedactEnabled } : undefined)),
    },
  };
  registerSideChatHandlers(deps as never);
}

beforeEach(() => {
  handlers.clear();
  sent.length = 0;
});

describe("side-chat IPC domain", () => {
  it("send drives the side loop and streams to lvis:sidechat:stream (never chat.stream)", async () => {
    const side = makeSideLoop();
    const main = makeMainLoop();
    register(side, main);
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), { input: "hello" });

    expect(result).toMatchObject({ ok: true });
    // The SIDE loop ran the turn; the MAIN loop was never touched.
    expect(side.runTurn).toHaveBeenCalledTimes(1);
    expect(main.runTurn).not.toHaveBeenCalled();
    // Every published frame went to the dedicated side-chat stream channel.
    expect(sent.length).toBeGreaterThan(0);
    for (const frame of sent) {
      expect(frame.channel).toBe(CHANNELS.sidechat.stream);
      expect(frame.channel).not.toBe(CHANNELS.chat.stream);
    }
  });

  // Side chat is a second send site into the same provider, and redaction lives at
  // the send sites rather than inside the loop — so this path simply did not have
  // one. With `piiRedactEnabled` on, the raw text the user typed went out on the
  // wire. These two assert the DLP boundary from the PRODUCER side: what the loop
  // actually received, not what the sanitizer returns in isolation.
  it("redacts side-chat input before it reaches the loop when PII redaction is on", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop(), true);
    const handler = handlers.get(CHANNELS.sidechat.send)!;

    await handler(ev("file:///index.html"), { input: "email me at alice@example.com" });

    expect(side.runTurn).toHaveBeenCalledTimes(1);
    const forwarded = side.runTurn.mock.calls[0]![0] as string;
    expect(forwarded).not.toContain("alice@example.com");
  });

  it("forwards side-chat input verbatim when PII redaction is off", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop(), false);
    const handler = handlers.get(CHANNELS.sidechat.send)!;

    await handler(ev("file:///index.html"), { input: "email me at alice@example.com" });

    const forwarded = side.runTurn.mock.calls[0]![0] as string;
    expect(forwarded).toBe("email me at alice@example.com");
  });
  // Side chat parses its own payload — it never passes through `parseChatSendPayload`
  // — so a per-turn bound enforced at either send gate would simply not exist here.
  // It holds because the bound lives at the turn-entry chokepoint both paths share.
  it("enforces the resource-attachment bound on the side loop too", async () => {
    const side = makeSideLoop();
    const main = makeMainLoop();
    register(side, main);
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const fence = (i: number) =>
      `${MCP_RESOURCE_FENCE_OPEN} server="s" uri="file:///f${i}">\nB${i}\n</mcp-resource>`;

    const result = await handler(ev("file:///index.html"), {
      input: "compare these",
      attachments: Array.from({ length: MCP_RESOURCE_ATTACHMENTS_PER_TURN + 1 }, (_, i) => ({
        type: "text",
        text: fence(i),
      })),
    });

    expect(result).toMatchObject({ ok: false, error: "too-many-resource-attachments" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });

  it("abort aborts the side loop only", async () => {
    const side = makeSideLoop();
    const main = makeMainLoop();
    register(side, main);
    const handler = handlers.get(CHANNELS.sidechat.abort)!;
    const result = await handler(ev("file:///index.html"));
    expect(result).toEqual({ ok: true });
    expect(side.abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(main.abortCurrentTurn).not.toHaveBeenCalled();
  });

  it("new creates a fresh session on the side loop", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.new)!;
    const result = await handler(ev("file:///index.html"));
    expect(result).toEqual({ ok: true, sessionId: "34fd6270-309d-4e47-878b-75c0742a6ac2" });
    expect(side.newConversation).toHaveBeenCalledTimes(1);
  });

  it("new aborts + awaits an in-flight turn BEFORE starting the fresh session", async () => {
    // A side loop whose turn stays in-flight until we release it, so we can
    // observe the ordering: abort → turn settles → newConversation.
    let releaseTurn!: () => void;
    const order: string[] = [];
    const side = makeSideLoop();
    side.runTurn = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseTurn = () => {
            order.push("turn-settled");
            resolve({ route: "chat" });
          };
        }),
    );
    side.abortCurrentTurn = vi.fn(() => {
      order.push("abort");
      // A real abort makes the in-flight runTurn settle.
      releaseTurn?.();
    });
    side.newConversation = vi.fn(() => order.push("newConversation"));
    register(side, makeMainLoop());

    // Start a turn (do NOT await — it is deliberately in-flight).
    const sendHandler = handlers.get(CHANNELS.sidechat.send)!;
    const sendPromise = sendHandler(ev("file:///index.html"), { input: "long turn" });

    // While it streams, request a new session.
    const newHandler = handlers.get(CHANNELS.sidechat.new)!;
    const result = await newHandler(ev("file:///index.html"));

    expect(result).toEqual({ ok: true, sessionId: "34fd6270-309d-4e47-878b-75c0742a6ac2" });
    // The in-flight turn was aborted + awaited BEFORE the loop was mutated —
    // no new-session-receives-prior-turn-frames leak.
    expect(order).toEqual(["abort", "turn-settled", "newConversation"]);
    expect(side.abortCurrentTurn).toHaveBeenCalledTimes(1);
    await sendPromise;
  });

  it("load aborts + awaits an in-flight turn BEFORE loading the session", async () => {
    let releaseTurn!: () => void;
    const order: string[] = [];
    const side = makeSideLoop();
    side.runTurn = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseTurn = () => {
            order.push("turn-settled");
            resolve({ route: "chat" });
          };
        }),
    );
    side.abortCurrentTurn = vi.fn(() => {
      order.push("abort");
      releaseTurn?.();
    });
    side.loadSession = vi.fn(() => {
      order.push("loadSession");
      return true;
    });
    register(side, makeMainLoop());

    const sendHandler = handlers.get(CHANNELS.sidechat.send)!;
    const sendPromise = sendHandler(ev("file:///index.html"), { input: "long turn" });

    const loadHandler = handlers.get(CHANNELS.sidechat.load)!;
    const result = await loadHandler(ev("file:///index.html"), "a17050c7-bb84-4fde-8554-b9ef7a678a92");

    expect(result).toMatchObject({ ok: true });
    expect(order).toEqual(["abort", "turn-settled", "loadSession"]);
    await sendPromise;
  });

  it("list fails closed on an unauthorized frame (no session-id disclosure)", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.list)!;
    const result = await handler(ev("https://evil.example.com"));
    // No real current-session id — same empty shape as the loop-absent branch.
    expect(result).toEqual({ current: null, sessions: [] });
    expect(side.getSessionId).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized frame on send", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("https://evil.example.com"), { input: "hello" });
    expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });

  it("rejects a send carrying neither text nor an attachment", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), { input: "   " });
    expect(result).toMatchObject({ ok: false, error: "empty-text" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });

  // The shared composer offers an attachment-only send on this surface, and the
  // main chat accepts one. Refusing it here produced an empty user bubble
  // followed by an error entry — the renderer had already committed the turn.
  it("accepts an attachment-only send (no text)", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), {
      input: "",
      attachments: [{ type: "image", image: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`, mimeType: "image/png" }],
    });

    expect(result).toMatchObject({ ok: true });
    expect(side.runTurn).toHaveBeenCalledTimes(1);
    const [, , , options] = side.runTurn.mock.calls[0] as unknown as [
      string,
      unknown,
      unknown,
      { attachments?: unknown[] },
    ];
    expect(options.attachments).toHaveLength(1);
  });

  // Two turns on one ConversationLoop interleave into a single history. The
  // handler runs `runStreamedTurn` directly, so nothing else refuses the second
  // send: a queue drain fired by a superseded turn's trailing `done` would have
  // landed here on top of the live turn.
  it("refuses a second send while a side turn is still streaming", async () => {
    let releaseTurn!: () => void;
    const side = makeSideLoop();
    side.runTurn = vi.fn(
      () => new Promise((resolve) => { releaseTurn = () => resolve({ route: "chat" }); }),
    );
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;

    const first = handler(ev("file:///index.html"), { input: "first" });
    const second = await handler(ev("file:///index.html"), { input: "second" });

    expect(second).toMatchObject({ ok: false, error: "streaming-active" });
    expect(side.runTurn).toHaveBeenCalledTimes(1);

    releaseTurn();
    await first;

    // …and the loop is free again once the turn settles. Swap in a turn that
    // completes on its own so this send is not held by the same latch.
    const settledTurn = vi.fn(async () => ({ route: "chat" }));
    side.runTurn = settledTurn;
    const third = await handler(ev("file:///index.html"), { input: "third" });
    expect(third).toMatchObject({ ok: true });
    expect(settledTurn).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the side-chat loop is absent", async () => {
    register(undefined, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), { input: "hello" });
    expect(result).toMatchObject({ ok: false, error: "side-chat-unavailable" });
  });
});
