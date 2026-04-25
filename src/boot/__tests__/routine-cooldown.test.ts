/**
 * RoutineTriggerCoordinator — global cooldown (dedup) tests.
 *
 * Verifies:
 * - First evaluation fires runRoutine.
 * - Second evaluation within debounce window is suppressed.
 * - isWithinGlobalCooldown() helper returns correct state.
 */
import { describe, it, expect, vi } from "vitest";
import {
  RoutineTriggerCoordinator,
  createIdleSignal,
  createPostTurnSignal,
} from "../../core/routine-trigger-coordinator.js";

function makeMockEngine() {
  return {
    runRoutine: vi.fn(async () => ({
      routineId: "wakeup",
      trigger: "wakeup" as const,
      summary: "done",
      generatedAt: new Date().toISOString(),
    })),
  };
}

describe("RoutineTriggerCoordinator — global cooldown", () => {
  it("IDLE_SCAN fires runRoutine; post-turn 1 min later is suppressed by global cooldown", async () => {
    const engine = makeMockEngine();
    let lastFiredAt = 0;
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine as any,
      getWakeupPrompt: () => "test wakeup prompt",
      evaluators: [
        createIdleSignal(() => true),
        createPostTurnSignal({
          isEnabled: () => true,
          getLastFiredAt: () => lastFiredAt,
          setLastFiredAt: (ts) => { lastFiredAt = ts; },
          getCooldownMs: () => 0,
        }),
      ],
      tickIntervalMs: 999999,
      debounceMs: 10 * 60_000,
    });

    // First fire via idle
    await coord._testEvaluate("tick");
    expect(engine.runRoutine).toHaveBeenCalledTimes(1);

    // Second fire via post-turn — within global debounce
    await coord._testEvaluate("event:post-turn");
    expect(engine.runRoutine).toHaveBeenCalledTimes(1);
  });

  it("isWithinGlobalCooldown returns false before any fire", () => {
    const engine = makeMockEngine();
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine as any,
      getWakeupPrompt: () => "test wakeup prompt",
      evaluators: [],
      tickIntervalMs: 999999,
      debounceMs: 10 * 60_000,
    });
    expect(coord.isWithinGlobalCooldown()).toBe(false);
  });
});
