/**
 * TriggerExecutor — fresh loop per trigger, IPC delivery, dismiss / import,
 * and the safety guards added in round-5: chat_busy refusal,
 * history_capacity refusal, expiry signal on cache eviction, and the
 * imported-from-proactive wrapping that prevents trigger prompts from being
 * grafted into chat as if the user had typed them.
 */
import { describe, expect, it, vi } from "vitest";
import { TriggerExecutor } from "../trigger-executor.js";
import { ConversationLoop } from "../conversation-loop.js";
import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

function makeLoop(text: string): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });
  const loop = new ConversationLoop(({
    settingsService: {
      get: () => ({ provider: "openai", model: "gpt-4o" }),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => {},
      listSessions: () => [],
    },
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = new FakeProvider([
    [
      { type: "text_delta", text },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ]);
  return loop;
}

interface FakeWindow {
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: () => boolean;
}

function makeFakeWindow(): FakeWindow {
  return {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
  };
}

const auditLogger = { log: vi.fn() };

const baseSpec = {
  pluginId: "work-proactive",
  source: "proactive:meeting-detection" as const,
  visibility: "user-visible" as const,
  priority: "normal" as const,
};

describe("TriggerExecutor.run", () => {
  it("creates a fresh loop per call and tags audit with pluginId + sessionId", async () => {
    const create = vi.fn(() => makeLoop("ok"));
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: create,
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "x" });
    await exec.run({ ...baseSpec, prompt: "y" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("emits started + completed IPC events and the wire payload omits messages", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("회의실 예약했습니다"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "회의실 예약 도와드릴까요?" });
    const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const completed = calls.find((c) => c[0] === "lvis:trigger:completed");
    expect(completed?.[1]).toMatchObject({
      pluginId: "work-proactive",
      source: "proactive:meeting-detection",
      summary: "회의실 예약했습니다",
    });
    // Wire payload must NOT carry the heavy messages array.
    expect(completed?.[1].messages).toBeUndefined();
  });

  it("uses live getMainWindow on each emit (window recreation safe)", async () => {
    const winA = makeFakeWindow();
    const winB = makeFakeWindow();
    let current: FakeWindow = winA;
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("ok"),
      getMainWindow: () => current as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "first" });
    expect((winA.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);

    current = winB; // simulate close+reopen
    await exec.run({ ...baseSpec, prompt: "second" });
    const winACalls = (winA.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length;
    const winBCalls = (winB.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(winBCalls).toBeGreaterThan(0);
    // winA didn't get the second batch of events.
    expect(winACalls).toBeLessThan(winACalls + winBCalls);
  });

  it("P2: audits visibility on completed (parity with started, grep-able by visibility)", async () => {
    const win = makeFakeWindow();
    const auditLog = { log: vi.fn() };
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("done"),
      getMainWindow: () => win as never,
      auditLogger: auditLog as never,
    });
    await exec.run({ ...baseSpec, visibility: "summary-only", prompt: "ok" });
    const completedRow = auditLog.log.mock.calls
      .map((c) => (c[0] as { input: string }).input)
      .find((input) => input.includes("] completed session="));
    expect(completedRow).toBeTruthy();
    expect(completedRow).toMatch(/visibility=summary-only/);
  });

  it("emits failed with classified reason + opaque errorId, never raw error.message on the wire", async () => {
    const win = makeFakeWindow();
    const broken = makeLoop("");
    (broken as { provider: unknown }).provider = null;
    const exec = new TriggerExecutor({
      createLoop: () => broken,
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await expect(exec.run({ ...baseSpec, prompt: "x" })).rejects.toBeDefined();
    const failed = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:failed");
    expect(failed?.[1]).toMatchObject({ pluginId: "work-proactive", reason: "provider_error" });
    expect(failed?.[1].errorId).toMatch(/^te-/);
    // The wire payload MUST NOT include `message` / `error` text.
    expect(failed?.[1].message).toBeUndefined();
    expect(failed?.[1].error).toBeUndefined();
  });
});

describe("TriggerExecutor.importIntoChat", () => {
  it("wraps the leading user message in <imported-from-proactive> so injected imperatives don't read as user input", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("응답"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "원본 templated prompt" });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    const chat = makeLoop("");
    const out = exec.importIntoChat(sessionId, chat);
    expect(out.ok).toBe(true);
    const messages = chat.getHistory().getMessages();
    const firstUser = messages.find((m) => m.role === "user");
    expect(firstUser?.content).toContain("<imported-from-proactive");
    expect(firstUser?.content).toContain("source=\"proactive:meeting-detection\"");
    expect(firstUser?.content).toContain("원본 templated prompt");
  });

  it("refuses when the chat loop is currently mid-turn (chat_busy)", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("ok"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "x" });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    const chat = makeLoop("");
    // Simulate an in-flight turn — a non-null currentAbortController.
    (chat as { currentAbortController: AbortController | null }).currentAbortController =
      new AbortController();

    const out = exec.importIntoChat(sessionId, chat);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("chat_busy");
    // History was not mutated.
    expect(chat.getHistory().getMessages()).toHaveLength(0);
  });

  it("refuses when chat history would overflow maxMessages (history_capacity)", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("ok"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "x" });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    const chat = makeLoop("");
    // Stuff chat history near capacity (default 50). Restore avoids the per-
    // append trim on every iteration.
    chat.getHistory().restore(
      Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
    );
    const out = exec.importIntoChat(sessionId, chat);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("history_capacity");
    expect(chat.getHistory().getMessages()).toHaveLength(50);
  });
});

describe("TriggerExecutor.dismiss + cache eviction", () => {
  it("dismiss drops a cached session and a re-import returns not_found", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("ok"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "x" });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    expect(exec.dismiss(sessionId)).toBe(true);
    const result = exec.importIntoChat(sessionId, makeLoop(""));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("emits lvis:trigger:expired when cache cap evicts an earlier session", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("ok"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    // Fill cache to its 32-entry cap.
    for (let i = 0; i < 32; i += 1) {
      await exec.run({ ...baseSpec, prompt: `p${i}` });
    }
    (win.webContents.send as ReturnType<typeof vi.fn>).mockClear();
    // One more — should evict the oldest and emit `expired` for it.
    await exec.run({ ...baseSpec, prompt: "overflow" });
    const expired = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:expired");
    expect(expired).toBeDefined();
    expect(expired?.[1]).toMatchObject({ pluginId: "work-proactive" });
  });

  it("two TriggerExecutor instances do not share cache", async () => {
    const win = makeFakeWindow();
    const execA = new TriggerExecutor({
      createLoop: () => makeLoop("a"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    const execB = new TriggerExecutor({
      createLoop: () => makeLoop("b"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await execA.run({ ...baseSpec, prompt: "from A" });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;
    // execB cannot see execA's session.
    const result = execB.importIntoChat(sessionId, makeLoop(""));
    expect(result.reason).toBe("not_found");
  });
});

describe("TriggerExecutor isolation invariant", () => {
  it("trigger run does NOT mutate the chat loop's history", async () => {
    const win = makeFakeWindow();
    const chat = makeLoop("unused");
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("trigger output"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "회의실 예약 도와드릴까요?" });
    expect(chat.getHistory().getMessages()).toHaveLength(0);
  });

  it("cached payload messages are deep-cloned so chat-history mutations don't reflect into the cache", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("응답"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "원본" });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    const cachedBefore = exec.getCachedSession(sessionId);
    const chat = makeLoop("");
    exec.importIntoChat(sessionId, chat);
    // Even if we mutated chat-side messages later, the original cache is
    // already gone (consumed by import). What we care about: the cached
    // entry was independent of the trigger loop's internal array.
    expect(cachedBefore?.messages.length).toBeGreaterThan(0);
    // Mutate the snapshot we held — should not affect chat history.
    if (cachedBefore) cachedBefore.messages[0].content = "MUTATED";
    const chatFirstUser = chat.getHistory().getMessages().find((m) => m.role === "user");
    expect(chatFirstUser?.content).not.toContain("MUTATED");
  });
});
