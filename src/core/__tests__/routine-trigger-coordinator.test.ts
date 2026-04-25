/**
 * RoutineTriggerCoordinator — unit tests (post-wakeup-refactor).
 */
import { describe, it, expect, vi } from "vitest";
import {
  RoutineTriggerCoordinator,
  createIdleSignal,
  createScheduleSignal,
  createPostTurnSignal,
  type SignalResult,
} from "../routine-trigger-coordinator.js";
import {
  getKstMinuteKey,
  normalizeScheduleEntries,
} from "../../routines/schedule.js";

function makeRoutineResult(id = "wakeup") {
  return {
    routineId: id,
    trigger: "wakeup" as const,
    summary: "done",
    generatedAt: new Date().toISOString(),
  };
}

function fakeEngine() {
  const results: unknown[] = [];
  return {
    results,
    engine: {
      runRoutine: vi.fn(async () => makeRoutineResult()),
    } as any,
  };
}

// ─── schedule helpers ─────────────────────────────────────────────────────────

describe("schedule helpers", () => {
  it("getKstMinuteKey returns a string for any date", () => {
    const key = getKstMinuteKey(new Date());
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  it("normalizeScheduleEntries returns a default entry for null/undefined", () => {
    const result = normalizeScheduleEntries(null as any);
    expect(result.length).toBe(1);
    expect(result).toEqual(normalizeScheduleEntries(undefined as any));
  });

  it("normalizeScheduleEntries maps all items (normalizing invalid ones)", () => {
    const result = normalizeScheduleEntries([
      { id: "e1", enabled: true, schedule: {}, prompt: "p" },
      { id: "e2", enabled: false, schedule: {}, prompt: "q" },
    ] as any);
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("e1");
  });
});

// ─── idleSignal ───────────────────────────────────────────────────────────────

describe("idleSignal", () => {
  it("fires when isLongIdle returns true", () => {
    const sig = createIdleSignal(() => true);
    const result = sig.evaluate(new Date(), "tick") as SignalResult;
    expect(result?.fire).toBe(true);
  });

  it("does not fire when not idle", () => {
    const sig = createIdleSignal(() => false);
    const result = sig.evaluate(new Date(), "tick");
    expect(result).toBeNull();
  });
});

// ─── scheduleSignal ───────────────────────────────────────────────────────────

describe("scheduleSignal", () => {
  it("does not fire when disabled", () => {
    const sig = createScheduleSignal({
      isEnabled: () => false,
      getLastFiredDayKey: () => undefined,
      setLastFiredDayKey: vi.fn(),
    });
    expect(sig.evaluate(new Date(), "tick")).toBeNull();
  });
});

// ─── postTurnSignal ───────────────────────────────────────────────────────────

describe("postTurnSignal", () => {
  it("fires on post-turn event when enabled and outside cooldown", () => {
    const sig = createPostTurnSignal({
      isEnabled: () => true,
      getLastFiredAt: () => 0,
      setLastFiredAt: vi.fn(),
    });
    const result = sig.evaluate(new Date(), "event:post-turn") as SignalResult;
    expect(result?.fire).toBe(true);
  });

  it("does not fire when source is not post-turn", () => {
    const sig = createPostTurnSignal({
      isEnabled: () => true,
      getLastFiredAt: () => 0,
      setLastFiredAt: vi.fn(),
    });
    expect(sig.evaluate(new Date(), "tick")).toBeNull();
  });

  it("respects cooldown", () => {
    const sig = createPostTurnSignal({
      isEnabled: () => true,
      getLastFiredAt: () => Date.now() - 1000,
      setLastFiredAt: vi.fn(),
      getCooldownMs: () => 60_000,
    });
    expect(sig.evaluate(new Date(), "event:post-turn")).toBeNull();
  });
});

// ─── RoutineTriggerCoordinator ────────────────────────────────────────────────

describe("RoutineTriggerCoordinator", () => {
  it("calls engine.runRoutine when a signal fires", async () => {
    const { engine } = fakeEngine();
    const completed: unknown[] = [];
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      onRoutineCompleted: (r) => { completed.push(r); },
      evaluators: [createIdleSignal(() => true)],
      tickIntervalMs: 999999,
      debounceMs: 0,
    });

    await coord._testEvaluate("tick");

    expect(engine.runRoutine).toHaveBeenCalledTimes(1);
    expect(completed.length).toBe(1);
  });

  it("debounces within the cooldown window", async () => {
    const { engine } = fakeEngine();
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [createIdleSignal(() => true)],
      tickIntervalMs: 999999,
      debounceMs: 30 * 60_000,
    });

    await coord._testEvaluate("tick");
    await coord._testEvaluate("tick");

    expect(engine.runRoutine).toHaveBeenCalledTimes(1);
  });

  it("post-turn signal fires runRoutine only for explicit post-turn events", async () => {
    const { engine } = fakeEngine();
    let lastFiredAt = 0;
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [
        createPostTurnSignal({
          isEnabled: () => true,
          getLastFiredAt: () => lastFiredAt,
          setLastFiredAt: (ts) => { lastFiredAt = ts; },
          getCooldownMs: () => 0,
        }),
      ],
      tickIntervalMs: 999999,
      debounceMs: 0,
    });

    await coord._testEvaluate("tick");
    expect(engine.runRoutine).not.toHaveBeenCalled();

    await coord._testEvaluate("event:post-turn");
    expect(engine.runRoutine).toHaveBeenCalledTimes(1);
  });

  it("isWithinGlobalCooldown returns true immediately after fire", async () => {
    const { engine } = fakeEngine();
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [createIdleSignal(() => true)],
      tickIntervalMs: 999999,
      debounceMs: 30 * 60_000,
    });

    expect(coord.isWithinGlobalCooldown()).toBe(false);
    await coord._testEvaluate("tick");
    expect(coord.isWithinGlobalCooldown()).toBe(true);
  });
});
