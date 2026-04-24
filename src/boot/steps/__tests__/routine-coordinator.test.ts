import { describe, expect, it, vi } from "vitest";
import { wireRoutineCoordinator } from "../routine-coordinator.js";

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    enableWakeupRoutine: true,
    scheduleTimeKst: "08:30",
    enableScheduleRoutine: false,
    enableShutdownRoutine: false,
    scheduleEntries: [],
    ...overrides,
  };
}

describe("wireRoutineCoordinator", () => {
  it("runs wakeup routine on IDLE_SCAN transition and calls onRoutineCompleted", async () => {
    let listener: ((newState: string, oldState: string, reason: string) => void) | null = null;

    const mockResult = {
      routineId: "wakeup",
      trigger: "wakeup" as const,
      summary: "wakeup done",
      generatedAt: new Date().toISOString(),
    };

    const runRoutine = vi.fn(async () => mockResult);
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };

    const wired = wireRoutineCoordinator({
      routineEngine: { runRoutine } as any,
      taskService: { getPendingByPriority: () => [] } as any,
      pluginRuntime: {
        findPluginIdByCapability: vi.fn(() => undefined),
        getPluginManifest: vi.fn(() => undefined),
      } as any,
      settingsService: { get: () => makeSettings() } as any,
      idleScheduler: {
        getState: () => "ACTIVE",
        setStateChangeListener: vi.fn((cb) => {
          listener = cb;
        }),
      } as any,
      mainWindow: mainWindow as any,
    });

    // Trigger idle-scan transition
    listener?.("IDLE_SCAN", "ACTIVE", "test");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wakeup", trigger: "wakeup" }),
    );
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      "lvis:routine:completed",
      expect.objectContaining({ summary: "wakeup done" }),
    );

    wired.dispose();
  });

  it("dedupes schedule entry execution within the same minute", async () => {
    const intervalCallbacks: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: TimerHandler) => {
      intervalCallbacks.push(cb as () => void);
      return { unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    const runRoutine = vi.fn(async () => ({
      routineId: "s-1",
      trigger: "schedule" as const,
      summary: "sched done",
      generatedAt: new Date().toISOString(),
    }));

    const wired = wireRoutineCoordinator({
      routineEngine: { runRoutine } as any,
      taskService: { getPendingByPriority: () => [] } as any,
      pluginRuntime: {
        findPluginIdByCapability: vi.fn(() => undefined),
        getPluginManifest: vi.fn(() => undefined),
      } as any,
      settingsService: {
        get: () =>
          makeSettings({
            enableScheduleRoutine: true,
            scheduleEntries: [
              {
                id: "s-1",
                enabled: true,
                prompt: "check in",
                schedule: { minute: "*", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
              },
            ],
          }),
      } as any,
      idleScheduler: {
        getState: () => "ACTIVE",
        setStateChangeListener: vi.fn(),
      } as any,
      mainWindow: { isDestroyed: () => true, webContents: { send: vi.fn() } } as any,
    });

    // maybeRunScheduleRoutines is called immediately at wire time
    await Promise.resolve();
    expect(runRoutine).toHaveBeenCalledTimes(1);

    // Second call in same minute should dedupe
    intervalCallbacks[0]?.();
    expect(runRoutine).toHaveBeenCalledTimes(1);

    wired.dispose();
    expect(clearIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
