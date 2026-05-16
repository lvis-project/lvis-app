import { describe, expect, it, vi } from "vitest";
import { runShutdownRoutines } from "../shutdown-routines.js";
import type { RoutineRecord } from "../../shared/routines-types.js";

function routine(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: "shutdown-llm",
    trigger: "shutdown",
    execution: "llm-session",
    prePrompt: "정리",
    title: "종료 정리",
    createdAt: "2026-05-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("runShutdownRoutines", () => {
  it("persists the llm-session routine id after markFired clears stale ids", async () => {
    const calls: string[] = [];
    const record = routine();
    const routinesStore = {
      listActive: vi.fn(() => [record]),
      markFired: vi.fn(async (id: string) => {
        calls.push(`markFired:${id}`);
        return { ...record, lastFiredAt: "2026-05-16T01:00:00.000Z" };
      }),
      update: vi.fn(async (id: string, patch: Partial<Pick<RoutineRecord, "lastRoutineSessionId">>) => {
        calls.push(`update:${id}:${patch.lastRoutineSessionId}`);
        return { ...record, ...patch };
      }),
    };
    const routineEngine = {
      runRoutine: vi.fn(async () => {
        calls.push("runRoutine");
        return {
          routineId: record.id,
          trigger: "shutdown" as const,
          summary: "done",
          generatedAt: "2026-05-16T01:00:00.000Z",
          sessionId: "routine-session-2",
        };
      }),
    };

    await runShutdownRoutines({ routinesStore, routineEngine });

    expect(routineEngine.runRoutine).toHaveBeenCalledWith(expect.objectContaining({
      id: "shutdown-llm",
      trigger: "shutdown",
      prePrompt: "정리",
      title: "종료 정리",
      signal: expect.any(AbortSignal),
    }));
    expect(calls).toEqual([
      "runRoutine",
      "markFired:shutdown-llm",
      "update:shutdown-llm:routine-session-2",
    ]);
    expect(routinesStore.update).toHaveBeenCalledWith("shutdown-llm", {
      lastRoutineSessionId: "routine-session-2",
    });
  });
});
