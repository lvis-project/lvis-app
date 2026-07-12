/**
 * Engine guidance buffer + round-boundary inject — regression guard for the
 * "guide" mode of the chat utterance taxonomy (`src/shared/chat-utterance.ts`).
 *
 * Contract (re-stated for future readers):
 *   - `queueGuidance(text)` returns `"queued" | "no-active-turn" | "queue-full"
 *     | "too-long" | "empty"`. Bounded by `GUIDE_MAX_ENTRIES` (16) and
 *     `GUIDE_MAX_CHARS` (8000) — caller MUST surface non-"queued" results
 *     so the renderer can preserve the user's typed text.
 *   - At each round boundary AFTER round 0 (between tool execution end and
 *     the next LLM stream), any buffered text is drained, joined with
 *     `"\n\n"`, prepended with the "[방향 지시 — ...]" marker, and appended
 *     to history as a `user` message so the model sees it like normal input.
 *   - Per user spec "방향지시는 endturn 전에 영향을 미치는 거": when a turn
 *     would end (no tool calls or stopReason="end_turn") but guide is queued,
 *     the loop refuses to return and falls through to one more round so the
 *     LLM responds to the queued direction-adjustment. Round-cap still applies
 *     — if cap is reached, `onGuidanceDropped` fires and the user sees a
 *     visible "방향 지시 미적용" system entry.
 *   - `onGuidanceInjected(text)` and `onGuidanceDropped(text)` callbacks fire
 *     per round-boundary drain / per turn-end drop so the renderer surfaces
 *     visible system entries.
 *   - `hasActiveTurn()` is `currentAbortController !== null`, set just before
 *     `queryLoop` and cleared in `runTurn`'s `finally`.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { MemoryManager } from "../../memory/memory-manager.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  /**
   * Optional hook fired right BEFORE the next turn yields its first event.
   * Tests use this to call `queueGuidance` after the turn has started (so
   * `currentAbortController` is set and the active-turn check passes)
   * without needing to spin up real concurrent IPC traffic.
   */
  beforeNextTurn?: () => void;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    this.beforeNextTurn?.();
    this.beforeNextTurn = undefined;
    yield* this.turns[this.index++] ?? [];
  }
}

function makeLoop(
  provider: LLMProvider,
  overrides: Record<string, unknown> = {},
  configureTools?: (toolRegistry: ToolRegistry) => void,
): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "noop_tool",
    description: "no-op",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  }));
  configureTools?.(toolRegistry);
  const loop = new ConversationLoop(({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system" },
    keywordEngine: new KeywordEngine(),
    routeEngine: new RouteEngine({ toolRegistry }),
    toolRegistry,
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    ...overrides,
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

function getHistory(loop: ConversationLoop) {
  return (loop as unknown as { history: { getMessages: () => Array<{ role: string; content: unknown }> } }).history.getMessages();
}

function cloneHistoryLikeAppliedCompaction(loop: ConversationLoop): void {
  const history = (loop as unknown as {
    history: {
      getMessages: () => GenericMessage[];
      restore: (messages: GenericMessage[]) => void;
    };
  }).history;
  history.restore(history.getMessages().map((message) => ({
    ...message,
    ...(message.meta ? { meta: { ...message.meta } } : {}),
  })));
}

class DeferredGate<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

describe("ConversationLoop guidance queue + boundary inject", () => {
  it("queues guide text and injects it at the next round boundary (between tool rounds)", async () => {
    const provider = new FakeProvider([
      // Round 0: emit tool_call so the loop runs a second round.
      [
        { type: "text_delta", text: "보고를 시작합니다." } as StreamEvent,
        { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      // Round 1 (after tool result): final text.
      [
        { type: "text_delta", text: "방향 반영 결과." } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    // Queue mid-turn (after currentAbortController is set, before round 1
    // starts) so the active-turn check passes and the inject site catches it.
    provider.beforeNextTurn = () => {
      // First yield of turn 0 — controller is set; queue guidance now.
      // (Subsequent yields no-op because `beforeNextTurn = undefined`.)
    };
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const dispositions: string[] = [];
    let injectedAckFinished = false;

    // Schedule queueGuidance right after runTurn starts.
    const turnPromise = loop.runTurn(
      "긴 보고서 만들어줘",
      { onGuidanceInjected: (t) => injected.push(t) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    // Microtask ordering: by the time the first stream event resolves, the
    // controller has been set. Queue guidance now.
    await Promise.resolve();
    loop.queueGuidanceWithDisposition("더 짧게 요약", {
      onInjected: async () => {
        await Promise.resolve();
        dispositions.push("injected");
        injectedAckFinished = true;
      },
      onDropped: (reason) => dispositions.push(`dropped:${reason}`),
    });
    await turnPromise;

    expect(injected).toEqual(["더 짧게 요약"]);
    expect(dispositions).toEqual(["injected"]);
    expect(injectedAckFinished).toBe(true);
    const userMessages = getHistory(loop).filter((m) => m.role === "user");
    expect(userMessages.some((m) => typeof m.content === "string" && m.content.includes("더 짧게 요약"))).toBe(true);
  });

  it("joins multiple queued utterances at the same boundary with blank-line separators", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "done" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const turnPromise = loop.runTurn(
      "작업 시작",
      { onGuidanceInjected: (t) => injected.push(t) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await Promise.resolve();
    loop.queueGuidance("첫번째 지시");
    loop.queueGuidance("두번째 지시");
    await turnPromise;

    expect(injected).toHaveLength(1);
    expect(injected[0]).toBe("첫번째 지시\n\n두번째 지시");
  });

  it("extends a 1-round turn by one round to deliver queued guide BEFORE end-turn", async () => {
    // User spec: "방향지시는 endturn 전에 영향을 미치는 거". A naive
    // single-round turn would let end_turn ship before the inject site runs;
    // queryLoop now refuses to return when guidance is queued, falling
    // through to one more round so the LLM responds with the guide applied.
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "원래 답" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "수정 답" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const dropped: string[] = [];
    const turnPromise = loop.runTurn(
      "질문",
      { onGuidanceInjected: (t) => injected.push(t), onGuidanceDropped: (t) => dropped.push(t) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await Promise.resolve();
    loop.queueGuidance("더 짧게");
    await turnPromise;

    expect(injected).toEqual(["더 짧게"]);
    expect(dropped).toEqual([]);
  });

  it("propagates injected A2A provenance to receiver ApprovalGate on the next round", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "tool_call", id: "t2", name: "noop_tool", input: {} } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "done" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const dir = mkdtempSync(join(tmpdir(), "lvis-a2a-guidance-gate-"));
    const permissionManager = new PermissionManager(join(dir, "permissions.json"));
    permissionManager.checkDetailed = () => ({
      decision: "allow",
      reason: "receiver auto-allow",
      layer: 3,
    });
    const approvalGate = {
      requestAndWait: vi.fn(async (request: { id: string }) => ({
        requestId: request.id,
        choice: "allow-once" as const,
      })),
    };
    const loop = makeLoop(provider, {
      permissionManager,
      approvalGate,
    });

    try {
      const turnPromise = loop.runTurn(
        "start",
        undefined,
        undefined,
        { inputOrigin: "user-keyboard" },
      );
      await Promise.resolve();
      expect(loop.queueGuidanceWithDisposition(
        "[Sub-Agent: researcher] finished",
        { approvalReasonPrefix: "[Sub-Agent: researcher]" },
      )).toBe("queued");
      await turnPromise;

      expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
      expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "[Sub-Agent: researcher] receiver auto-allow",
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gates intercepted request_plugin and tool_search calls with A2A provenance", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "meta-1", name: "request_plugin", input: { pluginId: "missing" } } as StreamEvent,
        { type: "tool_call", id: "meta-2", name: "tool_search", input: { query: "noop_tool" } } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "done" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const approvalGate = {
      requestAndWait: vi.fn(async (request: { id: string }) => ({
        requestId: request.id,
        choice: "allow-once" as const,
      })),
    };
    const loop = makeLoop(
      provider,
      { approvalGate },
      (toolRegistry) => {
        for (const name of ["request_plugin", "tool_search"]) {
          toolRegistry.register(createDynamicTool({
            name,
            description: name,
            source: "builtin",
            category: "read",
            isReadOnly: () => true,
            jsonSchema: { type: "object", properties: {} },
            execute: async () => ({ output: "interception-regressed", isError: true }),
          }));
        }
      },
    );

    await loop.runTurn(
      "start",
      undefined,
      undefined,
      {
        inputOrigin: "agent-message",
        initialGuidance: "[Sub-Agent: researcher] delivered work",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
      },
    );

    expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(2);
    const requests = approvalGate.requestAndWait.mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.toolName).sort()).toEqual([
      "request_plugin",
      "tool_search",
    ]);
    for (const request of requests) {
      expect(request).toMatchObject({
        toolCategory: "meta",
        isReadOnly: false,
        mode: "ask_all",
      });
      expect(request.reason).toContain("[Sub-Agent: researcher]");
    }
  });
  it("rejects empty / oversized / no-active-turn cases by return code", () => {
    const provider = new FakeProvider([]);
    const loop = makeLoop(provider);
    // No active turn — IPC handler must surface this so renderer keeps text.
    expect(loop.queueGuidance("뭔가")).toBe("no-active-turn");
    // Synthesize an active turn for the rest of the matrix.
    (loop as { currentAbortController: AbortController | null }).currentAbortController = new AbortController();
    expect(loop.queueGuidance("")).toBe("empty");
    expect(loop.queueGuidance("   \n\t  ")).toBe("empty");
    expect(loop.queueGuidance("a".repeat(8_001))).toBe("too-long");
    expect(loop.queueGuidance("ok")).toBe("queued");
  });

  it("queue-full rejection at GUIDE_MAX_ENTRIES (16)", () => {
    const loop = makeLoop(new FakeProvider([]));
    (loop as { currentAbortController: AbortController | null }).currentAbortController = new AbortController();
    for (let i = 0; i < 16; i++) {
      expect(loop.queueGuidance(`g${i}`)).toBe("queued");
    }
    expect(loop.queueGuidance("overflow")).toBe("queue-full");
  });

  it("fires onGuidanceDropped when round-cap blocks the extension", async () => {
    // maxRounds: 1 → one assistant round allowed; extension would need a
    // second round, which the cap forbids. Queue must drain via the
    // drop-on-end path so the renderer surfaces the failure.
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "응답" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const dropped: string[] = [];
    const dispositions: string[] = [];
    const turnPromise = loop.runTurn(
      "q",
      { onGuidanceInjected: (t) => injected.push(t), onGuidanceDropped: (t) => dropped.push(t) },
      undefined,
      { inputOrigin: "user-keyboard", maxRounds: 1 },
    );
    await Promise.resolve();
    loop.queueGuidanceWithDisposition("late", {
      onInjected: () => dispositions.push("injected"),
      onDropped: (reason) => dispositions.push(`dropped:${reason}`),
    });
    await turnPromise;

    expect(injected).toEqual([]);
    expect(dropped).toEqual(["late"]);
    expect(dispositions).toEqual(["dropped:turn-ended"]);
  });

  it("`hasActiveTurn()` reflects in-flight runTurn for IPC gate", async () => {
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    expect(loop.hasActiveTurn()).toBe(false);
    const p = loop.runTurn("test", undefined, undefined, { inputOrigin: "user-keyboard" });
    await p;
    expect(loop.hasActiveTurn()).toBe(false);
  });
  it("drops guidance queued during a deferred prompt denial and never leaks it into session B", async () => {
    const provider = new FakeProvider([[
      { type: "text_delta", text: "session B response" } as StreamEvent,
      { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
    ]]);
    const skillOverlay = { clear: vi.fn() };
    const loop = makeLoop(provider, { skillOverlay });
    const gate = new DeferredGate<{ decision: "allow" | "deny"; reason: string }>();
    const gateEntered = new DeferredGate<void>();
    const promptSpy = vi.spyOn(loop, "fireUserPromptSubmit").mockImplementation(() => {
      gateEntered.resolve(undefined);
      return gate.promise;
    });
    const disposition = vi.fn();
    const rendererDropped = vi.fn();

    const deniedTurn = loop.runTurn(
      "session A",
      { onGuidanceDropped: rendererDropped },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await gateEntered.promise;
    expect(loop.queueGuidanceWithDisposition("A-only guidance", {
      onDropped: disposition,
    })).toBe("queued");
    loop.turnAdditionalDirectories = ["temporary-grant"];
    gate.resolve({ decision: "deny", reason: "policy deny" });

    await expect(deniedTurn).resolves.toMatchObject({ stopReason: "blocked" });
    expect(disposition).toHaveBeenCalledTimes(1);
    expect(disposition).toHaveBeenCalledWith("turn-ended");
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(rendererDropped).toHaveBeenCalledWith("A-only guidance");
    expect(loop.guidanceQueue).toEqual([]);
    expect(loop.turnAdditionalDirectories).toEqual([]);
    expect(loop.hasActiveTurn()).toBe(false);

    promptSpy.mockResolvedValue({ decision: "allow", reason: "allowed" });
    const injectedInB = vi.fn();
    await loop.runTurn(
      "session B",
      { onGuidanceInjected: injectedInB },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(injectedInB).not.toHaveBeenCalled();
    expect(
      getHistory(loop).some((message) =>
        typeof message.content === "string" && message.content.includes("A-only guidance")),
    ).toBe(false);
    expect(skillOverlay.clear).toHaveBeenLastCalledWith(loop.getSessionId());
  });

  it("cleans queued guidance when SessionStart throws before the prompt gate", async () => {
    const loop = makeLoop(new FakeProvider([]));
    const lifecycleGate = new DeferredGate<void>();
    const lifecycleEntered = new DeferredGate<void>();
    vi.spyOn(loop, "fireLifecycleEvent").mockImplementation(() => {
      lifecycleEntered.resolve(undefined);
      return lifecycleGate.promise;
    });
    const disposition = vi.fn();
    const rendererDropped = vi.fn();

    const turn = loop.runTurn(
      "session start failure",
      { onGuidanceDropped: rendererDropped },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await lifecycleEntered.promise;
    expect(loop.queueGuidanceWithDisposition("queued during SessionStart", {
      onDropped: disposition,
    })).toBe("queued");
    lifecycleGate.reject(new Error("SessionStart failure"));

    await expect(turn).rejects.toThrow("SessionStart failure");
    expect(disposition).toHaveBeenCalledTimes(1);
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(loop.guidanceQueue).toEqual([]);
    expect(loop.hasActiveTurn()).toBe(false);
  });

  it("cleans queued guidance when preflight throws before queryLoop", async () => {
    const loop = makeLoop(new FakeProvider([]));
    const preflightGate = new DeferredGate<boolean>();
    const preflightEntered = new DeferredGate<void>();
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(() => {
      preflightEntered.resolve(undefined);
      return preflightGate.promise;
    });
    const disposition = vi.fn();
    const rendererDropped = vi.fn();

    const turn = loop.runTurn(
      "preflight failure",
      { onGuidanceDropped: rendererDropped },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await preflightEntered.promise;
    expect(loop.queueGuidanceWithDisposition("queued during preflight", {
      onDropped: disposition,
    })).toBe("queued");
    preflightGate.reject(new Error("preflight failure"));

    await expect(turn).rejects.toThrow("preflight failure");
    expect(disposition).toHaveBeenCalledTimes(1);
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(loop.guidanceQueue).toEqual([]);
    expect(loop.hasActiveTurn()).toBe(false);
  });

  it("drops drained guidance when its round-boundary preflight throws", async () => {
    const provider = new FakeProvider([[
      { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
      { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
    ]]);
    const loop = makeLoop(provider);
    const injectionPreflight = new DeferredGate<boolean>();
    const injectionPreflightEntered = new DeferredGate<void>();
    let preflightCalls = 0;
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(() => {
      preflightCalls += 1;
      if (preflightCalls === 1) return Promise.resolve(false);
      injectionPreflightEntered.resolve(undefined);
      return injectionPreflight.promise;
    });
    const disposition = vi.fn();
    const rendererDropped = vi.fn();

    const turn = loop.runTurn(
      "injection preflight failure",
      { onGuidanceDropped: rendererDropped },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await Promise.resolve();
    expect(loop.queueGuidanceWithDisposition("drained before preflight", {
      onDropped: disposition,
    })).toBe("queued");
    await injectionPreflightEntered.promise;
    injectionPreflight.reject(new Error("injection preflight failure"));

    await expect(turn).rejects.toThrow("injection preflight failure");
    expect(disposition).toHaveBeenCalledTimes(1);
    expect(disposition).toHaveBeenCalledWith("turn-ended");
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(loop.guidanceQueue).toEqual([]);
    expect(
      getHistory(loop).some((message) =>
        typeof message.content === "string" && message.content.includes("drained before preflight")),
    ).toBe(false);
  });

  it("acknowledges running guidance only after a successful provider round commit", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "error", error: "synthetic provider failure" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "retry base response" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "retry consumed guidance" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected = vi.fn();
    const dropped = vi.fn();
    const rendererInjected = vi.fn();
    const rendererDropped = vi.fn();

    const failedTurn = loop.runTurn(
      "first attempt",
      {
        onGuidanceInjected: rendererInjected,
        onGuidanceDropped: rendererDropped,
      },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await Promise.resolve();
    expect(loop.queueGuidanceWithDisposition("durable child result", {
      onInjected: injected,
      onDropped: dropped,
    })).toBe("queued");

    await expect(failedTurn).resolves.toMatchObject({ stopReason: "stream-error" });
    expect(injected).not.toHaveBeenCalled();
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledWith("turn-ended");
    expect(rendererInjected).not.toHaveBeenCalled();
    expect(rendererDropped).toHaveBeenCalledTimes(1);
    expect(
      getHistory(loop).some((message) =>
        typeof message.content === "string" && message.content.includes("durable child result")),
    ).toBe(false);

    const retriedTurn = loop.runTurn(
      "second attempt",
      { onGuidanceInjected: rendererInjected },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await Promise.resolve();
    expect(loop.queueGuidanceWithDisposition("durable child result", {
      onInjected: injected,
      onDropped: dropped,
    })).toBe("queued");
    await expect(retriedTurn).resolves.toMatchObject({ stopReason: "end_turn" });

    expect(injected).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(rendererInjected).toHaveBeenCalledTimes(1);
    expect(rendererInjected).toHaveBeenCalledWith("durable child result");
    expect(
      getHistory(loop).filter((message) =>
        typeof message.content === "string" && message.content.includes("durable child result")),
    ).toHaveLength(1);
  });

  it("rolls back failed initialGuidance after an applied-compaction clone and retains one successful reinjection", async () => {
    const provider = new FakeProvider([
      [{ type: "error", error: "initial guidance provider failure" } as StreamEvent],
      [
        { type: "text_delta", text: "consumed" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(async () => {
      cloneHistoryLikeAppliedCompaction(loop);
      return true;
    });
    const initialGuidance = "[Sub-Agent: Researcher]\ndurable child result";

    await expect(loop.runTurn(
      "parent request",
      undefined,
      undefined,
      {
        inputOrigin: "user-keyboard",
        initialGuidance,
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      },
    )).resolves.toMatchObject({ stopReason: "stream-error" });
    expect(
      getHistory(loop).filter((message) =>
        typeof message.content === "string" && message.content.includes("durable child result")),
    ).toHaveLength(0);

    await expect(loop.runTurn(
      "parent request",
      undefined,
      undefined,
      {
        inputOrigin: "user-keyboard",
        initialGuidance,
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      },
    )).resolves.toMatchObject({ stopReason: "end_turn" });

    const guidanceHistory = getHistory(loop).filter((message) =>
      typeof message.content === "string"
      && message.content.includes("durable child result"));
    // Only the successful turn retains the separate guidance-injection row.
    expect(guidanceHistory).toHaveLength(1);
  });

  it("rolls back a failed agent-message input after an applied-compaction clone and retains one successful retry", async () => {
    const provider = new FakeProvider([
      [{ type: "error", error: "agent message provider failure" } as StreamEvent],
      [
        { type: "text_delta", text: "consumed" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(async () => {
      cloneHistoryLikeAppliedCompaction(loop);
      return true;
    });
    const mailboxInput = "[Sub-Agent: Researcher]\ndurable autonomous wake result";

    await expect(loop.runTurn(
      mailboxInput,
      undefined,
      undefined,
      {
        inputOrigin: "agent-message",
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      },
    )).resolves.toMatchObject({ stopReason: "stream-error" });
    expect(
      getHistory(loop).filter((message) =>
        typeof message.content === "string"
        && message.content.includes("durable autonomous wake result")),
    ).toHaveLength(0);

    await expect(loop.runTurn(
      mailboxInput,
      undefined,
      undefined,
      {
        inputOrigin: "agent-message",
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      },
    )).resolves.toMatchObject({ stopReason: "end_turn" });

    expect(
      getHistory(loop).filter((message) =>
        typeof message.content === "string"
        && message.content.includes("durable autonomous wake result")),
    ).toHaveLength(1);
  });

  it.each([
    {
      label: "initialGuidance",
      input: "parent request",
      injectedText: "durable post-turn guidance",
      options: {
        inputOrigin: "user-keyboard" as const,
        initialGuidance: "[Sub-Agent: Researcher]\ndurable post-turn guidance",
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      },
    },
    {
      label: "agent-message",
      input: "[Sub-Agent: Researcher]\ndurable post-turn wake result",
      injectedText: "durable post-turn wake result",
      options: {
        inputOrigin: "agent-message" as const,
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      },
    },
  ])("durably rolls back $label when post-turn fails after saving the injected row", async ({
    input,
    injectedText,
    options,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-host-injection-rollback-"));
    const memoryManager = new MemoryManager({ lvisDir: dir });
    memoryManager.load();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "completed before post-turn failure" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    let dirtySnapshotSaved = false;
    const loop = makeLoop(provider, {
      memoryManager,
      postTurnHookChain: {
        run: async ({ sessionId, messages }: {
          sessionId: string;
          messages: GenericMessage[];
        }) => {
          expect(messages.some((message) =>
            typeof message.content === "string"
            && message.content.includes(injectedText))).toBe(true);
          await memoryManager.saveSession(sessionId, messages);
          dirtySnapshotSaved = true;
          throw new Error("synthetic post-turn failure");
        },
      },
    });

    try {
      await expect(loop.runTurn(input, undefined, undefined, options))
        .rejects.toThrow("synthetic post-turn failure");
      expect(dirtySnapshotSaved).toBe(true);

      const persisted = memoryManager.loadSession(loop.getSessionId()) ?? [];
      expect(persisted.some((message) => {
        if (message === null || typeof message !== "object") return false;
        const content = (message as { content?: unknown }).content;
        return typeof content === "string" && content.includes(injectedText);
      })).toBe(false);
      expect(getHistory(loop).some((message) =>
        typeof message.content === "string"
        && message.content.includes(injectedText))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
