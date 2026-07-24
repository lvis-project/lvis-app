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
      startRoutineConversation: vi.fn(async () => "test-session-id"),
      runTurn: vi.fn(async (prompt: string) => prompt + " 처리됨"),
      getLastAssistantMessage: vi.fn(async () => "오늘 업무 맥락 정리 처리됨"),
      cleanupSession: vi.fn(),
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

    expect(mockLoop.startRoutineConversation).toHaveBeenCalledWith(
      "schedule-daily",
      "schedule-daily",
      expect.any(String),
    );
    // routine-engine calls loop.runTurn(prePrompt, undefined, signal, options).
    expect(mockLoop.runTurn).toHaveBeenCalledWith(
      "오늘 업무 맥락 정리",
      undefined,
      undefined,
      { inputOrigin: "routine" },
    );
    expect(result.routineId).toBe("schedule-daily");
    expect(result.trigger).toBe("schedule");
    expect(result.sessionId).toBe("test-session-id");
  });
});
