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
import type { AuditEntry } from "../../audit/audit-logger.js";

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
  it("does NOT create a ConversationLoop — trigger sessions are pure notifications (no LLM)", async () => {
    // Earlier behaviour: each run() spun up a fresh loop and ran the
    // brain prompt through the LLM with full tool access. That let
    // write tools (calendar_create, email_create_event, ...) execute
    // BEFORE the user could approve. Now run() is a pure notification
    // path — no loop, no LLM, no autonomous side effects. Real work
    // happens in the user's chat session after they click 지금 답하기.
    const create = vi.fn(() => makeLoop("ok"));
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: create,
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "x" });
    await exec.run({ ...baseSpec, prompt: "y" });
    expect(create).toHaveBeenCalledTimes(0);
  });

  it("emits started + completed IPC events with summary === brain prompt", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("unused"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "회의 요청 이메일 도착. 진행할까요?" });
    const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const completed = calls.find((c) => c[0] === "lvis:trigger:completed");
    expect(completed?.[1]).toMatchObject({
      pluginId: "work-proactive",
      source: "proactive:meeting-detection",
      // Without an LLM, the toast text IS the brain prompt verbatim.
      summary: "회의 요청 이메일 도착. 진행할까요?",
      prompt: "회의 요청 이메일 도착. 진행할까요?",
    });
    // Wire payload omits the heavy messages array.
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

  it.each(["silent", "summary-only", "user-visible"] as const)(
    "P2: audits visibility=%s on completed (parity with started, grep-able by visibility)",
    async (visibility) => {
      const win = makeFakeWindow();
      const auditLog = { log: vi.fn() };
      const exec = new TriggerExecutor({
        createLoop: () => makeLoop("done"),
        getMainWindow: () => win as never,
        auditLogger: auditLog as never,
      });
      await exec.run({ ...baseSpec, visibility, prompt: "ok" });
      const inputs = auditLog.log.mock.calls.map((c) => (c[0] as AuditEntry).input ?? "");
      const completedRow = inputs.find((input) => input.includes("] completed session="));
      expect(completedRow).toBeTruthy();
      // Full-format match — locks field order so a future add can't slip
      // a new field between existing ones and silently break grep regexes.
      expect(completedRow).toMatch(
        new RegExp(
          String.raw`^\[trigger:work-proactive\] completed session=\S+ source=\S+ ` +
            String.raw`visibility=${visibility} summaryLen=\d+ toolCalls=\d+$`,
        ),
      );
    },
  );

  // Note: the prior "emits failed with classified reason" test relied on
  // run() invoking an LLM that could throw. Now run() has no LLM and
  // cannot fail at that layer — failures are constrained to the
  // host-side gate (`triggerConversation`) which classifies and emits
  // `lvis:trigger:failed` directly. That path is covered separately
  // in `boot/__tests__/proactive-trigger.test.ts`.
});

describe("TriggerExecutor.importIntoChat", () => {
  it("emits lvis:trigger:imported with a properly wrapped prompt (renderer fires the next chat turn)", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("unused"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "회의 요청 이메일을 받았습니다." });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    (win.webContents.send as ReturnType<typeof vi.fn>).mockClear();

    const chat = makeLoop("");
    const out = exec.importIntoChat(sessionId, chat);
    expect(out.ok).toBe(true);

    const imported = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:imported");
    expect(imported).toBeTruthy();
    const payload = imported?.[1] as {
      sessionId: string;
      source: string;
      prompt: string;
      summary: string;
      toolCallCount: number;
      importedAt: string;
      wrappedPrompt: string;
    };
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.source).toBe("proactive:meeting-detection");
    expect(payload.prompt).toBe("회의 요청 이메일을 받았습니다.");
    expect(payload.summary).toBe("회의 요청 이메일을 받았습니다.");
    expect(payload.toolCallCount).toBe(0); // no LLM ran in trigger session
    expect(typeof payload.importedAt).toBe("string");

    // The wrapped prompt is what the renderer chatSends as the next
    // user turn — the envelope keeps the LLM in a "treat as proactive,
    // ask before writes" stance via the system prompt's
    // <proactive-origin-guidance> block.
    expect(payload.wrappedPrompt).toBe(
      `<imported-from-proactive source="proactive:meeting-detection">\n` +
        `회의 요청 이메일을 받았습니다.\n` +
        `</imported-from-proactive>`,
    );
  });

  it("does NOT pre-append wrapped messages to chat history (renderer's chatSend handles append)", async () => {
    // Earlier behaviour pre-appended the trigger session's full
    // message list to chat history, then expected the user to type
    // something to engage. New flow: importIntoChat just emits the
    // event, renderer chatSends the wrappedPrompt → runTurn appends
    // exactly once via the normal chat path (cleaner streaming).
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("unused"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "x" });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    const chat = makeLoop("");
    const before = chat.getHistory().getMessages().length;
    exec.importIntoChat(sessionId, chat);
    const after = chat.getHistory().getMessages().length;
    expect(after).toBe(before);
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

  it("cached payload is consumed (deleted) by import so a second accept fails not_found", async () => {
    // Earlier deep-clone test guarded against shared-array mutation
    // when import pre-appended trigger session messages. With the new
    // flow there's no pre-append; the simpler invariant is "import
    // is one-shot" — the cache entry is gone after a successful
    // import, and a follow-up call gets `not_found`.
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("unused"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({ ...baseSpec, prompt: "x" });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    expect(exec.getCachedSession(sessionId)).not.toBeNull();
    const chat = makeLoop("");
    const first = exec.importIntoChat(sessionId, chat);
    expect(first.ok).toBe(true);
    expect(exec.getCachedSession(sessionId)).toBeNull();

    const second = exec.importIntoChat(sessionId, chat);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("not_found");
  });
});
