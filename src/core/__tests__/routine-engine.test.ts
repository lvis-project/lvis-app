/**
 * RoutineEngine.runRoutine — unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import { RoutineEngine } from "../routine-engine.js";

function makeLoop(opts: { text?: string; throws?: boolean } = {}) {
  return {
    getSessionId: vi.fn(() => "test-session-id"),
    startRoutineConversation: vi.fn(async () => "test-session-id"),
    runTurn: vi.fn(async () => {
      if (opts.throws) throw new Error("loop crashed");
      return { text: opts.text ?? "루틴 완료 메시지", toolCalls: [], route: "llm" };
    }),
    dispose: vi.fn(),
  };
}

describe("RoutineEngine.runRoutine", () => {
  it("returns RoutineResult with correct routineId, trigger, and generatedAt", async () => {
    const loop = makeLoop({ text: "완료" });
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({
      id: "schedule-daily",
      trigger: "schedule",
      prePrompt: "오늘 하루 알려줘.",
    });

    expect(result.routineId).toBe("schedule-daily");
    expect(result.trigger).toBe("schedule");
    expect(typeof result.generatedAt).toBe("string");
    expect(result.sessionId).toBe("test-session-id");
    expect(loop.startRoutineConversation).toHaveBeenCalledWith(
      "schedule-daily",
      "schedule-daily",
      expect.any(String),
    );
    expect(loop.runTurn).toHaveBeenCalledWith(
      "오늘 하루 알려줘.",
      undefined,
      undefined,
      { inputOrigin: "plugin-emitted" },
    );
  });

  it("uses <summary> tag content as summary", async () => {
    const loop = makeLoop({ text: "본문\n<summary>오늘 할 일 요약 텍스트</summary>" });
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({
      id: "shutdown",
      trigger: "shutdown",
      prePrompt: "정리해줘",
    });

    expect(result.summary).toBe("오늘 할 일 요약 텍스트");
  });

  it("returns missing-tag marker when runTurn returns no <summary> tag", async () => {
    const loop = {
      getSessionId: vi.fn(() => "test-session-id"),
      startRoutineConversation: vi.fn(async () => "test-session-id"),
      runTurn: vi.fn(async () => ({ text: "", toolCalls: [], route: "llm" })),
      dispose: vi.fn(),
    };
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({ id: "schedule", trigger: "schedule", prePrompt: "" });

    expect(result.summary).toBe("[요약 형식 누락]");
  });

  it("captures error message as summary when runTurn throws", async () => {
    const loop = makeLoop({ throws: true });
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({ id: "shutdown-daily", trigger: "shutdown", prePrompt: "" });

    expect(result.summary).toContain("loop crashed");
  });
});
