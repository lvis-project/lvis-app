import { describe, expect, it, vi } from "vitest";
import { wireRoutineCoordinator } from "../routine-coordinator.js";

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    enableDailyBriefing: true,
    scheduleTimeKst: "08:30",
    enableHeartbeat: true,
    enablePostTurnBriefing: false,
    heartbeatEntries: [],
    ...overrides,
  };
}

describe("wireRoutineCoordinator", () => {
  it("runs direct idle-scan briefing delivery and disposes idle listener", async () => {
    let listener: ((state: "IDLE_SCAN" | "ACTIVE", old: "IDLE_SCAN" | "ACTIVE", reason: string) => void) | null = null;
    const generateDailyBriefing = vi.fn(async () => ({
      status: "generated",
      briefing: {
        generatedAt: new Date().toISOString(),
        items: [{ category: "system", priority: "low", title: "idle" }],
        summary: "idle",
      },
    }));
    const saveSessionMetadata = vi.fn(async () => undefined);
    const saveSession = vi.fn(async () => undefined);
    const loadSession = vi.fn(() => []);
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };

    const pluginRuntime = {
      findPluginIdByCapability: vi.fn(() => undefined),
      getPluginManifest: vi.fn(() => undefined),
    };
    const wired = wireRoutineCoordinator({
      routineEngine: { generateDailyBriefing, runHeartbeatRoutine: vi.fn(async () => undefined) } as any,
      taskService: { getPendingByPriority: () => [] } as any,
      pluginRuntime: pluginRuntime as any,
      settingsService: { get: () => makeSettings() } as any,
      memoryManager: {
        listSessionsByRoutine: () => [],
        saveSessionMetadata,
        saveSession,
        loadSession,
      } as any,
      idleScheduler: {
        getState: () => "ACTIVE",
        setStateChangeListener: vi.fn((cb) => {
          listener = cb;
        }),
      } as any,
      mainWindow: mainWindow as any,
    });

    listener?.("IDLE_SCAN", "ACTIVE", "test");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(generateDailyBriefing).toHaveBeenCalledWith({ idleState: "long_idle" });
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      "lvis:routine:briefing",
      expect.objectContaining({ summary: "idle" }),
    );

    wired.dispose();
    expect(saveSessionMetadata).toHaveBeenCalled();
  });

  it("dedupes heartbeat execution within the same minute", async () => {
    let listener: ((state: "IDLE_SCAN" | "ACTIVE", old: "IDLE_SCAN" | "ACTIVE", reason: string) => void) | null = null;
    const runHeartbeatRoutine = vi.fn(async () => undefined);
    const intervalCallbacks: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: TimerHandler) => {
      intervalCallbacks.push(cb as () => void);
      return { unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    const pluginRuntime = {
      findPluginIdByCapability: vi.fn(() => undefined),
      getPluginManifest: vi.fn(() => undefined),
    };
    const wired = wireRoutineCoordinator({
      routineEngine: {
        generateDailyBriefing: vi.fn(async () => ({ status: "skipped", reason: "disabled" })),
        runHeartbeatRoutine,
      } as any,
      taskService: { getPendingByPriority: () => [] } as any,
      pluginRuntime: pluginRuntime as any,
      settingsService: {
        get: () =>
          makeSettings({
            heartbeatEntries: [
              {
                id: "hb-1",
                enabled: true,
                agentId: "monitor",
                schedule: { minute: "*", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
              },
            ],
          }),
      } as any,
      memoryManager: {
        listSessionsByRoutine: () => [],
        saveSessionMetadata: vi.fn(async () => undefined),
        saveSession: vi.fn(async () => undefined),
        loadSession: vi.fn(() => []),
      } as any,
      idleScheduler: {
        getState: () => "ACTIVE",
        setStateChangeListener: vi.fn((cb) => {
          listener = cb;
        }),
      } as any,
      mainWindow: { isDestroyed: () => true, webContents: { send: vi.fn() } } as any,
    });

    await Promise.resolve();
    expect(runHeartbeatRoutine).toHaveBeenCalledTimes(1);
    intervalCallbacks[0]?.();
    expect(runHeartbeatRoutine).toHaveBeenCalledTimes(1);

    wired.dispose();
    expect(clearIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
