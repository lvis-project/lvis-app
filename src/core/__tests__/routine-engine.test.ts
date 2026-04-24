/**
 * RoutineEngine.runRoutine — unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import { RoutineEngine } from "../routine-engine.js";

function makeLoop(opts: { text?: string; throws?: boolean } = {}) {
  return {
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
      id: "wakeup",
      trigger: "wakeup",
      prePrompt: "오늘 하루 알려줘.",
    });

    expect(result.routineId).toBe("wakeup");
    expect(result.trigger).toBe("wakeup");
    expect(typeof result.generatedAt).toBe("string");
    expect(loop.runTurn).toHaveBeenCalledWith("오늘 하루 알려줘.");
  });

  it("uses TurnResult.text as summary", async () => {
    const loop = makeLoop({ text: "오늘 할 일 요약 텍스트" });
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({
      id: "shutdown",
      trigger: "shutdown",
      prePrompt: "정리해줘",
    });

    expect(result.summary).toBe("오늘 할 일 요약 텍스트");
  });

  it("uses empty string summary when runTurn returns no text", async () => {
    const loop = { runTurn: vi.fn(async () => ({ text: "", toolCalls: [], route: "llm" })), dispose: vi.fn() };
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({ id: "schedule", trigger: "schedule" });

    expect(result.summary).toBe("");
  });

  it("captures error message as summary when runTurn throws", async () => {
    const loop = makeLoop({ throws: true });
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({ id: "wakeup", trigger: "wakeup" });

    expect(result.summary).toContain("loop crashed");
  });
});
