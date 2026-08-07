/**
 * `lvis:chat:fork` tool-pair invariant repair.
 *
 * The forked slice is written to a BRAND-NEW session file. If it carries an
 * assistant `toolCalls` entry whose `tool_result` was cut off by the slice, the
 * file on disk violates the provider pairing invariant for every reader that is
 * not `loadSession`.
 *
 * These tests drive the real registered IPC handler (not the repair function),
 * so they fail if the handler stops calling the repair authority at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invokeRegisteredHandler } from "../../../__tests__/test-helpers.js";
import type { GenericMessage } from "../../../engine/llm/types.js";

const CHANNEL = "lvis:chat:fork";
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

function historyWithOrphanToolCall(): GenericMessage[] {
  return [
    { role: "user", content: "please read the file" },
    { role: "assistant", content: "reading", toolCalls: [{ id: "tu-paired", name: "read_file", input: {} }] },
    { role: "tool_result", toolUseId: "tu-paired", content: "file body" },
    // The tool_result for `tu-orphan` never arrived (or was cut by the slice).
    { role: "assistant", content: "one more look", toolCalls: [{ id: "tu-orphan", name: "read_file", input: {} }] },
  ];
}

function makeDeps(history: GenericMessage[]) {
  return {
    conversationLoop: {
      getHistory: vi.fn(() => ({ getMessages: () => history, restore: vi.fn() })),
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

async function setup(history: GenericMessage[]) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  const deps = makeDeps(history);
  registerChatHandlers(deps as any);
  return deps;
}

/** The messages written to the NEW (forked) session, not the active one. */
function forkedMessages(deps: ReturnType<typeof makeDeps>): GenericMessage[] {
  const call = deps.memoryManager.saveSession.mock.calls.find(
    ([sessionId]: [string]) => sessionId !== ACTIVE_SESSION,
  );
  expect(call, "fork must write a new session file").toBeDefined();
  return call![1] as GenericMessage[];
}

describe("lvis:chat:fork — tool-pair invariant", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("writes the forked session without the unpaired assistant toolCalls entry", async () => {
    const deps = await setup(historyWithOrphanToolCall());
    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(handlers, CHANNEL, -1);
    expect(result.ok).toBe(true);

    const written = forkedMessages(deps);
    const toolCallIds = written.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : []));
    expect(toolCallIds).toEqual(["tu-paired"]);
  });

  it("keeps the assistant text of the repaired message and the paired tool_result", async () => {
    const deps = await setup(historyWithOrphanToolCall());
    await invokeRegisteredHandler<Promise<unknown>>(handlers, CHANNEL, -1);

    const written = forkedMessages(deps);
    expect(written.map((m) => m.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
    const last = written[3];
    expect(last.role === "assistant" && last.content).toBe("one more look");
    expect(written.some((m) => m.role === "tool_result" && m.toolUseId === "tu-paired")).toBe(true);
  });

  it("drops a tool_result whose assistant toolCalls entry is not in the slice", async () => {
    const deps = await setup([
      { role: "user", content: "hi" },
      // Assistant message carrying the call was lost; only the result survives.
      { role: "tool_result", toolUseId: "tu-dangling", content: "orphan result" },
    ]);
    await invokeRegisteredHandler<Promise<unknown>>(handlers, CHANNEL, -1);

    const written = forkedMessages(deps);
    expect(written.map((m) => m.role)).toEqual(["user"]);
  });

  it("leaves the ACTIVE session save unrepaired — only the fork target is normalized", async () => {
    const deps = await setup(historyWithOrphanToolCall());
    await invokeRegisteredHandler<Promise<unknown>>(handlers, CHANNEL, -1);

    const activeCall = deps.memoryManager.saveSession.mock.calls.find(
      ([sessionId]: [string]) => sessionId === ACTIVE_SESSION,
    );
    expect(activeCall).toBeDefined();
    const activeMessages = activeCall![1] as GenericMessage[];
    const activeIds = activeMessages.flatMap((m) =>
      m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [],
    );
    expect(activeIds).toEqual(["tu-paired", "tu-orphan"]);
  });
});
