import { describe, expect, it, vi } from "vitest";
import { createRoutineTriggerCoordinator } from "../routine.js";

describe("createRoutineTriggerCoordinator", () => {
  it("uses RoutineEngine calendar cache instead of calling plugin runtime directly", async () => {
    const generateDailyBriefing = vi.fn().mockResolvedValue({ status: "generated" });
    const getCalendarEvents = vi.fn(() => [
      {
        subject: "Design review",
        start: "2026-04-23T09:08:00+09:00",
        end: "2026-04-23T10:00:00+09:00",
      },
    ]);
    const pluginRuntime = {
      call: vi.fn(),
    };

    const coordinator = createRoutineTriggerCoordinator({
      routineEngine: {
        generateDailyBriefing,
        getCalendarEvents,
      } as never,
      taskService: {
        getPendingByPriority: () => [],
      } as never,
      pluginRuntime: pluginRuntime as never,
      isIdleScanActive: () => false,
      isScheduleEnabled: () => false,
      getScheduleLastFiredDayKey: () => undefined,
      setScheduleLastFiredDayKey: () => {},
      now: () => new Date("2026-04-23T08:59:00+09:00"),
      logger: () => {},
    });

    await coordinator._testEvaluate("test");

    expect(getCalendarEvents).toHaveBeenCalled();
    expect(pluginRuntime.call).not.toHaveBeenCalled();
    expect(generateDailyBriefing).toHaveBeenCalled();
  });
});
