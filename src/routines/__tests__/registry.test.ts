/**
 * routines/registry — buildRoutineForTrigger tests.
 *
 * Verifies that the helper sources prePrompt from settings (or defaults)
 * for all 3 routine types, and that schedule with no enabled entries fails
 * cleanly so the dev-trigger IPC can return a structured error.
 */
import { describe, it, expect } from "vitest";
import { buildRoutineForTrigger } from "../registry.js";
import {
  DEFAULT_SHUTDOWN_PROMPT,
  DEFAULT_WAKEUP_ROUTINE_PROMPT,
} from "../schedule.js";

describe("buildRoutineForTrigger", () => {
  it("wakeup uses configured prompt", () => {
    const built = buildRoutineForTrigger("wakeup", {
      enableWakeupRoutine: true,
      wakeupRoutinePrompt: "사용자 정의 모닝 브리핑 prompt",
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.routine.id).toBe("wakeup");
      expect(built.routine.trigger).toBe("wakeup");
      expect(built.routine.prePrompt).toBe("사용자 정의 모닝 브리핑 prompt");
      expect(built.routine.title).toBe("웨이크업 루틴");
    }
  });

  it("wakeup falls back to DEFAULT_WAKEUP_ROUTINE_PROMPT when unset", () => {
    const built = buildRoutineForTrigger("wakeup", { enableWakeupRoutine: true });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.routine.prePrompt).toBe(DEFAULT_WAKEUP_ROUTINE_PROMPT);
  });

  it("wakeup falls back when configured prompt is whitespace", () => {
    const built = buildRoutineForTrigger("wakeup", {
      enableWakeupRoutine: true,
      wakeupRoutinePrompt: "   ",
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.routine.prePrompt).toBe(DEFAULT_WAKEUP_ROUTINE_PROMPT);
  });

  it("shutdown uses configured prompt or default", () => {
    const built = buildRoutineForTrigger("shutdown", {
      enableWakeupRoutine: false,
      shutdownPrompt: "퇴근 정리",
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.routine.id).toBe("shutdown");
      expect(built.routine.prePrompt).toBe("퇴근 정리");
    }

    const fallback = buildRoutineForTrigger("shutdown", { enableWakeupRoutine: false });
    expect(fallback.ok).toBe(true);
    if (fallback.ok) expect(fallback.routine.prePrompt).toBe(DEFAULT_SHUTDOWN_PROMPT);
  });

  it("shutdown falls back when configured prompt is whitespace", () => {
    const built = buildRoutineForTrigger("shutdown", {
      enableWakeupRoutine: false,
      shutdownPrompt: "   \n\t  ",
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.routine.prePrompt).toBe(DEFAULT_SHUTDOWN_PROMPT);
  });

  it("schedule with undefined scheduleEntries falls back to default entry from normalizer", () => {
    // normalizeScheduleEntries returns [createDefaultScheduleEntry(0)] when
    // input is undefined; that entry has enabled=true so build succeeds.
    const built = buildRoutineForTrigger("schedule", {
      enableWakeupRoutine: false,
      enableScheduleRoutine: true,
      scheduleEntries: undefined,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.routine.trigger).toBe("schedule");
      expect(typeof built.routine.prePrompt).toBe("string");
      expect((built.routine.prePrompt ?? "").length).toBeGreaterThan(0);
    }
  });

  it("schedule picks the first enabled entry's prompt", () => {
    const built = buildRoutineForTrigger("schedule", {
      enableWakeupRoutine: false,
      enableScheduleRoutine: true,
      scheduleEntries: [
        {
          id: "schedule-1",
          enabled: false,
          agentId: "monitor",
          schedule: { minute: "0", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
          prompt: "비활성 prompt",
        },
        {
          id: "schedule-2",
          enabled: true,
          agentId: "monitor",
          schedule: { minute: "0", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
          prompt: "활성 prompt",
        },
      ],
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.routine.id).toBe("schedule-2");
      expect(built.routine.prePrompt).toBe("활성 prompt");
    }
  });

  it("schedule fails cleanly when no entries are enabled", () => {
    const built = buildRoutineForTrigger("schedule", {
      enableWakeupRoutine: false,
      enableScheduleRoutine: true,
      scheduleEntries: [
        {
          id: "schedule-1",
          enabled: false,
          agentId: "monitor",
          schedule: { minute: "0", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
          prompt: "off",
        },
      ],
    });
    expect(built).toEqual({ ok: false, error: "schedule-no-active-entry" });
  });

  it("unknown routine id returns routine-not-found", () => {
    const built = buildRoutineForTrigger("nonexistent", { enableWakeupRoutine: false });
    expect(built).toEqual({ ok: false, error: "routine-not-found" });
  });
});
