/**
 * Row addressing for the three actions that name a past message:
 * `lvis:chat:rewind-to`, `lvis:chat:edit-resend`, and `lvis:chat:fork`.
 *
 * They share one rule — resolve the row by its durable `messageId` — and this
 * file is where that rule is held to a conversation whose ENTRY count and ROW
 * count disagree. They used to disagree silently: an ordinal walk counted rows
 * while the renderer counted entries, so a pure tool round, a compact boundary,
 * or an imported trigger each shifted the target by one and the action cut the
 * wrong turn.
 *
 * ── rewind specifically ─────────────────────────────────────────────────────
 *
 * The renderer puts the message text back in the composer; main's whole job is
 * to cut the conversation at that message and WRITE the cut. Nothing else on
 * this path saves the session (unlike edit-resend, where the replayed turn
 * saves), so a handler that truncates in memory only would look correct until
 * the next session load brought the discarded turns back.
 *
 * These tests drive the real registered IPC handlers against a history fake that
 * actually mutates, so they fail if the truncate or the write is dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeRegisteredHandler } from "../../../__tests__/test-helpers.js";
import { ConversationHistory } from "../../../engine/conversation-history.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { serializeHistoryMessage } from "../../../shared/chat-history.js";
import { historyToEntries } from "../../../ui/renderer/utils/history.js";
import type { GenericMessage } from "../../../engine/llm/types.js";

const REWIND = "lvis:chat:rewind-to";
const FORK = "lvis:chat:fork";
const EDIT_RESEND = "lvis:chat:edit-resend";
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

/**
 * A conversation shaped like the ones the ordinal walk got wrong: a pure tool
 * round (an assistant row with EMPTY content, which the transcript draws as a
 * tool group and not as a card), a compact boundary (a user row the transcript
 * draws as a checkpoint divider), and an imported trigger (a user row drawn as
 * its own card). Each of those made the renderer's count and the host's count
 * disagree by one, so a rewind cut the wrong turn.
 */
function driftShapedHistory(): GenericMessage[] {
  return [
    { role: "user", content: "first question", meta: { messageId: "m-q1" } },
    { role: "assistant", content: "", meta: { messageId: "m-toolround" },
      toolCalls: [{ id: "tu-1", name: "read_file", input: {} }] },
    { role: "tool_result", toolUseId: "tu-1", content: "file body", meta: { messageId: "m-tr1" } },
    { role: "assistant", content: "first answer", meta: { messageId: "m-a1" } },
    { role: "user", content: "[compacted]",
      meta: { messageId: "m-boundary", compactBoundary: true, compactNum: 1 } },
    { role: "user", content: "imported", meta: { messageId: "m-trigger",
      importedTrigger: { sessionId: "s", source: "plugin", prompt: "p", summary: "b",
        toolCallCount: 0, importedAt: "2026-01-01T00:00:00.000Z" } } },
    { role: "assistant", content: "trigger answer", meta: { messageId: "m-a2" } },
    { role: "user", content: "third question", meta: { messageId: "m-q3" } },
    { role: "assistant", content: "third answer", meta: { messageId: "m-a3" } },
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
      pruneCheckpointsDiscardedByRewind: vi.fn(async () => undefined),
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

  it("cuts at the named row, not at the row an ordinal walk would have counted to", async () => {
    const deps = await setup(driftShapedHistory());

    // "m-q3" is the 4th user/assistant ENTRY the transcript shows, but the 8th
    // ROW. Counting either way lands somewhere else; the id does not.
    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(
      handlers, REWIND, "m-q3", "main",
    );

    expect(result.ok).toBe(true);
    expect(savedMessages(deps).map((m) => m.meta?.messageId)).toEqual([
      "m-q1", "m-toolround", "m-tr1", "m-a1", "m-boundary", "m-trigger", "m-a2",
    ]);
  });

  it("hands back the text the composer has to restore", async () => {
    await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; text?: string }>>(
      handlers, REWIND, "m-q3", "main",
    );

    expect(result.text).toBe("third question");
  });

  it("empties the session when the rewind targets the opening message", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(
      handlers, REWIND, "m-q1", "main",
    );

    expect(result.ok).toBe(true);
    expect(savedMessages(deps)).toEqual([]);
  });

  it("hands the pruner the rows this rewind discarded, not the rows that survived it", async () => {
    // What the pruner may delete is decided by which boundaries THIS rewind
    // threw away. Handing it the survivors instead would also condemn every
    // boundary an earlier compaction had already summarized away.
    const deps = await setup(driftShapedHistory());

    await invokeRegisteredHandler<Promise<{ ok: boolean }>>(handlers, REWIND, "m-q1", "main");

    expect(deps.memoryManager.pruneCheckpointsDiscardedByRewind).toHaveBeenCalledWith(
      ACTIVE_SESSION,
      driftShapedHistory(),
    );
  });

  it("restores the words the bubble showed, not the envelope stored around them", async () => {
    // A drained guide is stored wrapped in a routing envelope the user never
    // wrote, with the bare text recorded alongside it. Returning to that row
    // must put the user's own words in the composer.
    const deps = await setup([
      { role: "user", content: "first question", meta: { messageId: "m-q1" } },
      {
        role: "user",
        content: "[injection envelope]\n더 짧게",
        meta: { messageId: "m-guide", displayText: "더 짧게" },
      },
      { role: "assistant", content: "shorter answer", meta: { messageId: "m-a1" } },
    ]);

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; text?: string }>>(
      handlers, REWIND, "m-guide", "main",
    );

    expect(result).toMatchObject({ ok: true, text: "더 짧게" });
    expect(savedMessages(deps).map((m) => m.meta?.messageId)).toEqual(["m-q1"]);
  });

  it("refuses an assistant row — only the user's own input can be taken back", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, REWIND, "m-a1", "main",
    );

    expect(result).toEqual({ ok: false, error: "not-a-user-message" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("refuses a row that is no longer in the conversation", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, REWIND, "m-compacted-away", "main",
    );

    expect(result).toEqual({ ok: false, error: "message-not-found" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("refuses a missing identifier", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, REWIND, "", "main",
    );

    expect(result).toEqual({ ok: false, error: "invalid-message-id" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("refuses a message with an attachment rather than cutting it and losing the image", async () => {
    const deps = await setup([
      { role: "user", content: [
        { type: "text", text: "look at this" },
        { type: "image", image: "data:image/png;base64,AAAA", mimeType: "image/png" },
      ], meta: { messageId: "m-with-image" } },
      { role: "assistant", content: "I see it", meta: { messageId: "m-a" } },
    ]);

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, REWIND, "m-with-image", "main",
    );

    expect(result).toEqual({ ok: false, error: "attachment-not-restorable" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("returns the persona the turn was addressed with", async () => {
    await setup([
      { role: "user", content: "ask the reviewer",
        meta: { messageId: "m-persona", activePersonaPrompt: { id: "persona-7", name: "Reviewer" } } },
      { role: "assistant", content: "ok", meta: { messageId: "m-a" } },
    ]);

    const result = await invokeRegisteredHandler<
      Promise<{ ok: boolean; personaPromptId?: string }>
    >(handlers, REWIND, "m-persona", "main");

    expect(result.personaPromptId).toBe("persona-7");
  });
});

describe("lvis:chat:fork — same rule, same fixture", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("branches up to and including the named row, not the row an ordinal would reach", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(
      handlers, FORK, "m-q3", "main",
    );

    expect(result.ok).toBe(true);
    const forked = deps.memoryManager.saveSession.mock.calls.find(
      ([sessionId]: [string]) => sessionId !== ACTIVE_SESSION,
    );
    expect(forked, "fork must write a new session file").toBeDefined();
    expect((forked![1] as GenericMessage[]).map((m) => m.meta?.messageId)).toEqual([
      "m-q1", "m-toolround", "m-tr1", "m-a1", "m-boundary", "m-trigger", "m-a2", "m-q3",
    ]);
  });

  it("can branch from an assistant row, which is where the turn footer offers it", async () => {
    const deps = await setup(driftShapedHistory());

    await invokeRegisteredHandler<Promise<{ ok: boolean }>>(handlers, FORK, "m-a1", "main");

    const forked = deps.memoryManager.saveSession.mock.calls.find(
      ([sessionId]: [string]) => sessionId !== ACTIVE_SESSION,
    );
    expect((forked![1] as GenericMessage[]).map((m) => m.meta?.messageId)).toEqual([
      "m-q1", "m-toolround", "m-tr1", "m-a1",
    ]);
  });

  it("refuses a row that is gone rather than silently branching the whole conversation", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, FORK, "m-compacted-away", "main",
    );

    expect(result).toEqual({ ok: false, sessionId: null, error: "message-not-found" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });
});

describe("lvis:chat:edit-resend — same rule, same fixture", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("refuses a row that is gone instead of replaying whichever row an ordinal reaches", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, EDIT_RESEND, "m-compacted-away", "rewritten", "main",
    );

    expect(result).toEqual({ ok: false, error: "message-not-found" });
    // Nothing was cut: the replay never got past resolving its target.
    expect(deps.conversationLoop.getHistory().getMessages()).toHaveLength(9);
  });

  it("refuses a missing identifier before it touches the conversation", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, EDIT_RESEND, "", "rewritten", "main",
    );

    expect(result).toEqual({ ok: false, error: "invalid-message-id" });
    expect(deps.conversationLoop.getHistory().getMessages()).toHaveLength(9);
  });
});

/**
 * The seam the drift lived in, crossed for real: a genuine ConversationHistory
 * on one side, the renderer's own entry rebuild on the other, and nothing
 * mocked in between. The renderer picks the entry a user would click, reads the
 * id off it, and the registered handler resolves that id against the same
 * history. Any future divergence between how rows are stored and how entries
 * are built fails HERE rather than by cutting a user's conversation.
 */
describe("renderer entry → host row, end to end", () => {
  beforeEach(() => {
    handlers.clear();
  });

  function realHistoryWithDriftShapes(): ConversationHistory {
    const history = new ConversationHistory();
    history.append({ role: "user", content: "first question" });
    // Pure tool round: an assistant row with empty content, drawn as a tool
    // group and never as a card.
    history.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tu-1", name: "read_file", input: {} }],
    });
    history.append({ role: "tool_result", toolUseId: "tu-1", content: "file body" });
    history.append({ role: "assistant", content: "first answer" });
    // Compact boundary: a user row drawn as a checkpoint divider.
    history.append({
      role: "user",
      content: "[compacted]",
      meta: { compactBoundary: true, compactNum: 1, checkpointMeta: { removedMessages: 2, freedTokens: 10 } },
    });
    history.append({ role: "user", content: "third question" });
    history.append({ role: "assistant", content: "third answer" });
    return history;
  }

  it("cuts the row the clicked bubble stands for, across a tool round and a compact boundary", async () => {
    const history = realHistoryWithDriftShapes();
    const deps = makeDeps([]);
    deps.conversationLoop.getHistory = vi.fn(() => history) as never;
    handlers.clear();
    vi.clearAllMocks();
    const { registerChatHandlers } = await import("../chat.js");
    registerChatHandlers(deps as never);

    // Build the transcript exactly as the renderer does, from the same rows.
    const serialized = history
      .getMessages()
      .map((message, index) => serializeHistoryMessage(message, index));
    const entries = historyToEntries(serialized);

    // The user clicks their LAST question. It is the 3rd user/assistant ENTRY
    // the transcript shows and the 6th ROW — the numbers an ordinal walk on
    // either side would have produced disagree, and neither is the answer.
    const clicked = entries.filter((e) => e.kind === "user").at(-1);
    expect(clicked?.kind === "user" ? clicked.text : "").toBe("third question");
    const messageId = clicked?.kind === "user" ? clicked.messageId : undefined;
    expect(messageId, "every rebuilt user bubble is addressable").toBeDefined();

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; text?: string }>>(
      handlers, REWIND, messageId!, "main",
    );

    expect(result.ok).toBe(true);
    expect(result.text).toBe("third question");
    expect(history.getMessages().map((m) => m.content)).toEqual([
      "first question", "", "file body", "first answer", "[compacted]",
    ]);
  });
});

/**
 * Sessions written before rows carried an identity are still on disk, and two
 * readers open them: the sidebar renders a transcript from `loadSession`, and a
 * resumed loop restores its history from the same call. If those two produced
 * different identities for the same row, the id the user clicked would name
 * nothing the host could find — so `loadSession` mints one identity per row,
 * derived from the session and the row's position, and everything downstream
 * inherits it.
 */
describe("a session written before rows carried an identity", () => {
  const LEGACY_SESSION = "dddddddd-0000-1111-2222-333333333333";
  let dir: string;
  let mm: MemoryManager;

  beforeEach(() => {
    handlers.clear();
    dir = mkdtempSync(join(tmpdir(), "lvis-legacy-rows-"));
    mm = new MemoryManager({ lvisDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeLegacySession(): Promise<void> {
    await mm.saveSession(LEGACY_SESSION, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
    ]);
  }

  it("reads back the same identity for the same row on every load", async () => {
    await writeLegacySession();

    const first = mm.loadSession(LEGACY_SESSION)!;
    const second = mm.loadSession(LEGACY_SESSION)!;

    const ids = first.map((m) => (m as GenericMessage).meta?.messageId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.map((m) => (m as GenericMessage).meta?.messageId)).toEqual(ids);
  });

  it("restores into the loop under the ids the transcript shows, and rewinds to the clicked row", async () => {
    await writeLegacySession();
    const loaded = mm.loadSession(LEGACY_SESSION) as GenericMessage[];

    // The loop resumes from the same call the sidebar read.
    const history = new ConversationHistory();
    history.restore(loaded);
    expect(history.getMessages().map((m) => m.meta?.messageId)).toEqual(
      loaded.map((m) => m.meta?.messageId),
    );

    const deps = makeDeps([]);
    deps.conversationLoop.getHistory = vi.fn(() => history) as never;
    deps.conversationLoop.getSessionId = vi.fn(() => LEGACY_SESSION) as never;
    vi.clearAllMocks();
    const { registerChatHandlers } = await import("../chat.js");
    registerChatHandlers(deps as never);

    const entries = historyToEntries(
      loaded.map((message, index) => serializeHistoryMessage(message, index)),
    );
    const clicked = entries.filter((e) => e.kind === "user").at(-1);
    const messageId = clicked?.kind === "user" ? clicked.messageId : undefined;
    expect(messageId, "a legacy row is addressable once loaded").toBeDefined();

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; text?: string }>>(
      handlers, REWIND, messageId!, "main",
    );

    expect(result).toMatchObject({ ok: true, text: "second question" });
    expect(history.getMessages().map((m) => m.content)).toEqual([
      "first question", "first answer",
    ]);
  });
});
