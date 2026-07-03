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
    getSessionId: vi.fn(() => "side-1"),
    getHistory: vi.fn(() => ({ getMessages: vi.fn(() => []) })),
    listSessions: vi.fn(() => []),
    abortCurrentTurn: vi.fn(),
  };
}

function makeMainLoop() {
  return {
    runTurn: vi.fn(),
    abortCurrentTurn: vi.fn(),
    getSessionId: vi.fn(() => "main-1"),
  };
}

function register(sideLoop: unknown, mainLoop: unknown) {
  const deps = {
    conversationLoop: mainLoop,
    sideChatConversationLoop: sideLoop,
    auditLogger: { log: vi.fn() },
    getMainWindow: () => ({ webContents: {} }),
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
    expect(result).toEqual({ ok: true, sessionId: "side-1" });
    expect(side.newConversation).toHaveBeenCalledTimes(1);
  });

  it("rejects an unauthorized frame on send", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("https://evil.example.com"), { input: "hello" });
    expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });

  it("rejects empty input", async () => {
    const side = makeSideLoop();
    register(side, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), { input: "   " });
    expect(result).toMatchObject({ ok: false, error: "empty-text" });
    expect(side.runTurn).not.toHaveBeenCalled();
  });

  it("fails closed when the side-chat loop is absent", async () => {
    register(undefined, makeMainLoop());
    const handler = handlers.get(CHANNELS.sidechat.send)!;
    const result = await handler(ev("file:///index.html"), { input: "hello" });
    expect(result).toMatchObject({ ok: false, error: "side-chat-unavailable" });
  });
});
