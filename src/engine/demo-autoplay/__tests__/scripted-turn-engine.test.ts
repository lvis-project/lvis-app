/**
 * ScriptedTurnEngine unit tests — proposal §3 + §5 + §11.
 *
 * Coverage:
 *   - Phase order (user → tool calls → assistant → completed)
 *   - Abort idempotency (second abort is no-op)
 *   - Take-over mid-flight stops emission within one tick
 *   - sink.onAborted always fires exactly once
 *   - typeOn streams partial then final
 */
import { describe, it, expect } from "vitest";
import { ScriptedTurnEngine } from "../scripted-turn-engine.js";
import type {
  ScriptedAbortReason,
  ScriptedSink,
  ScriptedToolCall,
  ScriptedTurn,
} from "../types.js";

interface SinkEvent {
  kind:
    | "user"
    | "tool-call"
    | "tool-result"
    | "assistant"
    | "aborted";
  payload: unknown;
}

function makeSink(): { sink: ScriptedSink; events: SinkEvent[]; abortedCount: number; lastReason: ScriptedAbortReason | null } {
  const events: SinkEvent[] = [];
  let abortedCount = 0;
  let lastReason: ScriptedAbortReason | null = null;
  const sink: ScriptedSink = {
    emitUserMessage(text, isFinal) {
      events.push({ kind: "user", payload: { text, isFinal } });
    },
    emitToolCall(call, status) {
      events.push({ kind: "tool-call", payload: { tool: call.toolName, status } });
    },
    emitToolResult(call, result) {
      events.push({ kind: "tool-result", payload: { tool: call.toolName, result } });
    },
    emitAssistantDelta(text, isFinal) {
      events.push({ kind: "assistant", payload: { text, isFinal } });
    },
    onAborted(reason) {
      abortedCount += 1;
      lastReason = reason;
      events.push({ kind: "aborted", payload: reason });
    },
  };
  return {
    sink,
    events,
    get abortedCount() {
      return abortedCount;
    },
    get lastReason() {
      return lastReason;
    },
  } as unknown as {
    sink: ScriptedSink;
    events: SinkEvent[];
    abortedCount: number;
    lastReason: ScriptedAbortReason | null;
  };
}

function makeTurn(overrides: Partial<ScriptedTurn> = {}): ScriptedTurn {
  const toolCalls: ScriptedToolCall[] = [
    {
      toolName: "meeting_list",
      labelKo: "최근 회의",
      fakeResultKo: "3건 발견",
      delayMs: 0,
    },
  ];
  return {
    id: "test",
    titleKo: "테스트",
    userMessage: "hi",
    toolCalls,
    assistantResponse: "ok",
    typeOnMsPerChar: 0,
    ...overrides,
  };
}

const instantSleep = () => Promise.resolve();

describe("ScriptedTurnEngine", () => {
  it("emits phases in user → tool → assistant order", async () => {
    const { sink, events } = makeSink();
    const engine = new ScriptedTurnEngine({ sleep: instantSleep });
    await engine.start(makeTurn(), sink);

    const kinds = events.map((e) => e.kind);
    // first emission must be user, last (before aborted) is assistant
    expect(kinds[0]).toBe("user");
    const userIndex = kinds.lastIndexOf("user");
    const toolCallIndex = kinds.indexOf("tool-call");
    const assistantIndex = kinds.indexOf("assistant");
    const abortedIndex = kinds.indexOf("aborted");
    expect(userIndex).toBeLessThan(toolCallIndex);
    expect(toolCallIndex).toBeLessThan(assistantIndex);
    expect(assistantIndex).toBeLessThan(abortedIndex);
  });

  it("calls sink.onAborted exactly once with 'completed' on natural finish", async () => {
    const tracker = makeSink();
    const engine = new ScriptedTurnEngine({ sleep: instantSleep });
    await engine.start(makeTurn(), tracker.sink);
    expect(tracker.events.filter((e) => e.kind === "aborted")).toHaveLength(1);
    const final = tracker.events.find((e) => e.kind === "aborted");
    expect(final?.payload).toBe("completed");
  });

  it("abort() is idempotent — second call does not refire onAborted", async () => {
    const tracker = makeSink();
    const engine = new ScriptedTurnEngine({ sleep: instantSleep });
    const promise = engine.start(makeTurn(), tracker.sink);
    engine.abort("user-takeover");
    engine.abort("user-input"); // ignored
    await promise;
    const abortedEvents = tracker.events.filter((e) => e.kind === "aborted");
    expect(abortedEvents).toHaveLength(1);
    expect(abortedEvents[0].payload).toBe("user-takeover");
  });

  it("take-over mid-flight skips remaining phases", async () => {
    const tracker = makeSink();
    // Use a slightly real sleep so abort can land between phases.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const engine = new ScriptedTurnEngine({ sleep });
    const turn = makeTurn({
      userMessage: "ab",
      assistantResponse: "should-not-appear",
      typeOnMsPerChar: 50,
      toolCalls: [],
    });
    const promise = engine.start(turn, tracker.sink);
    // Abort before user type-on completes
    setTimeout(() => engine.abort("user-input"), 30);
    await promise;
    const hasAssistant = tracker.events.some((e) => e.kind === "assistant");
    expect(hasAssistant).toBe(false);
    const aborted = tracker.events.filter((e) => e.kind === "aborted");
    expect(aborted).toHaveLength(1);
    expect(aborted[0].payload).toBe("user-input");
  });

  it("refuses to start() when already running", async () => {
    const tracker = makeSink();
    const engine = new ScriptedTurnEngine({ sleep: instantSleep });
    const first = engine.start(makeTurn(), tracker.sink);
    await expect(engine.start(makeTurn(), tracker.sink)).rejects.toThrow(/already running/);
    await first;
  });

  it("typeOn emits a final-flagged event with the complete string", async () => {
    const tracker = makeSink();
    const engine = new ScriptedTurnEngine({ sleep: instantSleep });
    await engine.start(makeTurn({ userMessage: "abc", toolCalls: [], assistantResponse: "ok" }), tracker.sink);
    const userFinals = tracker.events.filter(
      (e) => e.kind === "user" && (e.payload as { isFinal: boolean }).isFinal === true,
    );
    expect(userFinals).toHaveLength(1);
    expect((userFinals[0].payload as { text: string }).text).toBe("abc");
  });

  it("uses provided sandbox for resolve (DI hook)", async () => {
    const tracker = makeSink();
    const sandbox = {
      resolve: async () => ({ ok: true as const, result: "stub-result" }),
    };
    const engine = new ScriptedTurnEngine({ sleep: instantSleep, sandbox: sandbox as never });
    await engine.start(makeTurn(), tracker.sink);
    const result = tracker.events.find((e) => e.kind === "tool-result");
    expect((result?.payload as { result: string }).result).toBe("stub-result");
  });
});
