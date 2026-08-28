/**
 * `lvis:chat:rewind-to` — discard a turn without replaying it.
 *
 * The renderer puts the message text back in the composer; main's whole job is
 * to cut the conversation at that message and WRITE the cut. Nothing else on
 * this path saves the session (unlike edit-resend, where the replayed turn
 * saves), so a handler that truncates in memory only would look correct until
 * the next session load brought the discarded turns back.
 *
 * These tests drive the real registered IPC handler against a history fake that
 * actually mutates, so they fail if the truncate or the write is dropped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invokeRegisteredHandler } from "../../../__tests__/test-helpers.js";
import type { GenericMessage } from "../../../engine/llm/types.js";

const CHANNEL = "lvis:chat:rewind-to";
const ACTIVE_SESSION = "active-session";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

function twoTurnHistory(): GenericMessage[] {
  return [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
    { role: "assistant", content: "second answer" },
  ];
}

function makeDeps(seed: GenericMessage[]) {
  let messages = [...seed];
  return {
    conversationLoop: {
      getHistory: vi.fn(() => ({
        getMessages: () => messages,
        truncate: (count: number) => {
          messages = messages.slice(0, count);
        },
        restore: vi.fn(),
      })),
      getSessionId: vi.fn(() => ACTIVE_SESSION),
      getSessionKind: vi.fn(() => "main"),
      loadSession: vi.fn(() => true),
    } as any,
    settingsService: { get: vi.fn(() => ({})), patch: vi.fn(async () => undefined) } as any,
    memoryManager: {
      saveSession: vi.fn(async () => undefined),
      saveSessionMetadata: vi.fn(async () => undefined),
      loadSessionMetadata: vi.fn(() => null),
      rehydrateToolResultArtifacts: vi.fn((_id: string, msgs: GenericMessage[]) => msgs),
      markMainActiveResume: vi.fn(async () => undefined),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    getMainWindow: vi.fn(() => null),
  };
}

async function setup(seed: GenericMessage[]) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  const deps = makeDeps(seed);
  registerChatHandlers(deps as any);
  return deps;
}

function savedMessages(deps: ReturnType<typeof makeDeps>): GenericMessage[] {
  const call = deps.memoryManager.saveSession.mock.calls.at(-1);
  expect(call, "rewind must persist the truncated session").toBeDefined();
  expect(call![0]).toBe(ACTIVE_SESSION);
  return call![1] as GenericMessage[];
}

describe("lvis:chat:rewind-to", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("writes the session cut at the message, dropping the message and its answer", async () => {
    const deps = await setup(twoTurnHistory());

    // Ordinal 2 — the second user message, counting user/assistant rows only.
    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(handlers, CHANNEL, 2, "main");

    expect(result.ok).toBe(true);
    expect(savedMessages(deps).map((m) => m.content)).toEqual(["first question", "first answer"]);
  });

  it("empties the session when the rewind targets the opening message", async () => {
    const deps = await setup(twoTurnHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(handlers, CHANNEL, 0, "main");

    expect(result.ok).toBe(true);
    expect(savedMessages(deps)).toEqual([]);
  });

  it("refuses an assistant row — only the user's own input can be taken back", async () => {
    const deps = await setup(twoTurnHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, CHANNEL, 1, "main",
    );

    expect(result).toEqual({ ok: false, error: "not-a-user-message" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("refuses an ordinal past the end of the conversation", async () => {
    const deps = await setup(twoTurnHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, CHANNEL, 9, "main",
    );

    expect(result).toEqual({ ok: false, error: "index-out-of-range" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });
});
