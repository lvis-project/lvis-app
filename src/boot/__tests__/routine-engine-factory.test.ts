/**
 * createRoutineEngine — unit test.
 *
 * Verifies the factory wires a RoutineEngine that delegates to a
 * ConversationLoop created by the provided factory.
 */
import { describe, it, expect, vi } from "vitest";
import { createRoutineEngine } from "../routine.js";

describe("createRoutineEngine", () => {
  it("createRoutineEngine returns a RoutineEngine with runRoutine", () => {
    const mockLoop = {
      run: vi.fn(async () => "요약 완료"),
      getLastAssistantMessage: vi.fn(async () => "요약 완료"),
      dispose: vi.fn(),
    };

    const engine = createRoutineEngine({
      createConversationLoop: () => mockLoop as any,
    });

    expect(typeof engine.runRoutine).toBe("function");
  });

  it("runRoutine calls loop.runTurn with the prePrompt", async () => {
    const mockLoop = {
      runTurn: vi.fn(async (prompt: string) => prompt + " 처리됨"),
      getLastAssistantMessage: vi.fn(async () => "오늘 업무 맥락 정리 처리됨"),
      dispose: vi.fn(),
    };

    const engine = createRoutineEngine({
      createConversationLoop: () => mockLoop as any,
    });

    const result = await engine.runRoutine({
      id: "wakeup",
      trigger: "wakeup",
      prePrompt: "오늘 업무 맥락 정리",
    });

    expect(mockLoop.runTurn).toHaveBeenCalledWith("오늘 업무 맥락 정리");
    expect(result.routineId).toBe("wakeup");
    expect(result.trigger).toBe("wakeup");
  });
});
