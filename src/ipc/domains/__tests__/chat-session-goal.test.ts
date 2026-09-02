/**
 * Stop means stop — including the goal.
 *
 * A running goal takes the turn lease back the moment a turn settles, so a
 * Stop that only interrupts the turn would be undone a tick later and read as
 * the app ignoring the button. `lvis:chat:abort` therefore pauses the goal of
 * the conversation that group is holding, before it interrupts. `pause`, not
 * clear: the rounds already spent are kept, so resuming carries on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { invokeRegisteredHandler } from "../../../__tests__/test-helpers.js";
import { createConversationSurfaceRuntime } from "../../../engine/conversation-surface-runtime.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { SessionGoalStore } from "../../../main/session-goal-store.js";
import type { SessionGoal } from "../../../shared/session-goal.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const SESSION = "conv-with-goal";

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const disk = new Map<string, SessionGoal | null>();
  const sessionGoalStore = new SessionGoalStore({
    load: (sid) => disk.get(sid) ?? null,
    save: async (sid, goal) => {
      disk.set(sid, goal);
    },
  });
  const abortCurrentTurn = vi.fn();
  const { registerChatHandlers } = await import("../chat.js");
  registerChatHandlers({
    conversationLoop: {
      getSessionId: () => SESSION,
      getSessionKind: () => "main",
      hasProvider: () => true,
      hasActiveTurn: () => false,
      abortCurrentTurn,
      getHistory: () => ({ length: 0, getMessages: () => [] }),
    },
    conversationSurfaceRuntime: createConversationSurfaceRuntime(),
    sessionGoalStore,
    settingsService: {
      get: vi.fn((key?: string) => (key === "llm" ? fakeLlmSettings() : {})),
      patch: vi.fn(async () => undefined),
    },
    memoryManager: {
      loadMainActiveSessionState: vi.fn(() => null),
      markMainActiveFresh: vi.fn(async () => undefined),
      saveSessionMetadata: vi.fn(async () => undefined),
    },
    auditLogger: { log: vi.fn() },
    getMainWindow: vi.fn(() => null),
  } as unknown as Parameters<typeof registerChatHandlers>[0]);
  return { sessionGoalStore, abortCurrentTurn };
}

beforeEach(() => {
  handlers.clear();
});

describe("lvis:chat:abort and the session goal", () => {
  it("pauses a running goal, keeping the rounds it has spent", async () => {
    const { sessionGoalStore, abortCurrentTurn } = await setup();
    await sessionGoalStore.set(SESSION, "ship the release");
    await sessionGoalStore.recordRevival(SESSION);
    await sessionGoalStore.recordRevival(SESSION);

    await expect(
      invokeRegisteredHandler<Promise<{ ok: boolean }>>(handlers, CHANNELS.chat.abort, "main"),
    ).resolves.toEqual({ ok: true });

    expect(abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(sessionGoalStore.get(SESSION)).toMatchObject({ status: "paused", round: 2 });
    // And it carries on from there when the user says so.
    expect(await sessionGoalStore.resume(SESSION)).toMatchObject({ status: "running", round: 2 });
  });

  it("leaves a completed goal alone and still stops the turn", async () => {
    const { sessionGoalStore, abortCurrentTurn } = await setup();
    await sessionGoalStore.set(SESSION, "ship the release");
    await sessionGoalStore.complete(SESSION);

    await invokeRegisteredHandler(handlers, CHANNELS.chat.abort, "main");
    expect(sessionGoalStore.get(SESSION)?.status).toBe("complete");
    expect(abortCurrentTurn).toHaveBeenCalledTimes(1);
  });

  it("stops the turn on a session that has no goal", async () => {
    const { abortCurrentTurn } = await setup();
    await expect(
      invokeRegisteredHandler<Promise<{ ok: boolean }>>(handlers, CHANNELS.chat.abort, "main"),
    ).resolves.toEqual({ ok: true });
    expect(abortCurrentTurn).toHaveBeenCalledTimes(1);
  });
});
