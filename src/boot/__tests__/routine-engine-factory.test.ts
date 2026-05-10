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
      getSessionId: vi.fn(() => "test-session-id"),
      runTurn: vi.fn(async (prompt: string) => prompt + " 처리됨"),
      getLastAssistantMessage: vi.fn(async () => "오늘 업무 맥락 정리 처리됨"),
      dispose: vi.fn(),
    };

    const engine = createRoutineEngine({
      createConversationLoop: () => mockLoop as any,
    });

    const result = await engine.runRoutine({
      id: "schedule-daily",
      trigger: "schedule",
      prePrompt: "오늘 업무 맥락 정리",
    });

    // routine-engine-v2 calls loop.runTurn(prePrompt, undefined, signal) —
    // the second/third args are the model-override and AbortSignal slots
    // (RoutineEngine doesn't pass either, so both default to undefined).
    expect(mockLoop.runTurn).toHaveBeenCalledWith("오늘 업무 맥락 정리", undefined, undefined);
    expect(result.routineId).toBe("schedule-daily");
    expect(result.trigger).toBe("schedule");
  });
});
