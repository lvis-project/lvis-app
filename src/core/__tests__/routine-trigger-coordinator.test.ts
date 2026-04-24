/**
 * Sprint 3-A-2 — RoutineTriggerCoordinator unit tests.
 * Each signal has dedicated coverage; coordinator-level debounce + disabled
 * kill switch validated.
 */
import { describe, it, expect, vi } from "vitest";
import {
  RoutineTriggerCoordinator,
  createIdleSignal,
  createScheduleSignal,
  createMeetingSignal,
  createTaskDeadlineSignal,
  createPostTurnSignal,
  type SignalResult,
} from "../routine-trigger-coordinator.js";
import {
  getKstMinuteKey,
  isValidHeartbeatEntries,
  isValidHeartbeatSchedule,
  matchesHeartbeatSchedule,
  normalizeHeartbeatEntries,
} from "../../routines/schedule.js";

function fakeEngine() {
  const calls: Array<{ idleState?: string; triggerReason?: string }> = [];
  return {
    calls,
    engine: {
      // cast via unknown to sidestep the full RoutineEngine surface
      generateDailyBriefing: vi.fn(async (opts: any) => {
        calls.push({ idleState: opts?.idleState, triggerReason: opts?.triggerReason });
        return { status: "generated", briefing: { generatedAt: "", items: [] } };
      }),
    } as any,
  };
}

describe("idleSignal", () => {
  it("fires when isLongIdle returns true", () => {
    const sig = createIdleSignal(() => true);
    expect(sig.evaluate(new Date())).toEqual({ fire: true, reason: "long_idle" });
  });
  it("returns null when not idle", () => {
    const sig = createIdleSignal(() => false);
    expect(sig.evaluate(new Date())).toBeNull();
  });
});

describe("scheduleSignal", () => {
  it("fires at 08:30 KST once per day when enabled", () => {
    let last: string | undefined;
    const sig = createScheduleSignal({
      getHhmmKst: () => "08:30",
      isEnabled: () => true,
      getLastFiredDayKey: () => last,
      setLastFiredDayKey: (k) => { last = k; },
    });
    // 2026-04-18 08:31 KST = 2026-04-17T23:31:00Z
    const now = new Date("2026-04-17T23:31:00Z");
    const r1 = sig.evaluate(now) as SignalResult;
    expect(r1.fire).toBe(true);
    // second call same day → null
    expect(sig.evaluate(now)).toBeNull();
  });
  it("does not fire when disabled", () => {
    const sig = createScheduleSignal({
      getHhmmKst: () => "08:30",
      isEnabled: () => false,
      getLastFiredDayKey: () => undefined,
      setLastFiredDayKey: () => {},
    });
    expect(sig.evaluate(new Date("2026-04-17T23:31:00Z"))).toBeNull();
  });
  it("does not fire outside target window", () => {
    const sig = createScheduleSignal({
      getHhmmKst: () => "08:30",
      isEnabled: () => true,
      getLastFiredDayKey: () => undefined,
      setLastFiredDayKey: () => {},
    });
    // 10:00 KST = 01:00 UTC
    expect(sig.evaluate(new Date("2026-04-18T01:00:00Z"))).toBeNull();
  });

  it("uses the latest configured time instead of the boot-time snapshot", () => {
    let hhmm = "08:30";
    let last: string | undefined;
    const sig = createScheduleSignal({
      getHhmmKst: () => hhmm,
      isEnabled: () => true,
      getLastFiredDayKey: () => last,
      setLastFiredDayKey: (key) => { last = key; },
    });

    expect(sig.evaluate(new Date("2026-04-17T23:31:00Z"))).not.toBeNull();

    last = undefined;
    hhmm = "08:32";
    expect(sig.evaluate(new Date("2026-04-17T23:31:00Z"))).toBeNull();
    expect(sig.evaluate(new Date("2026-04-17T23:32:00Z"))).not.toBeNull();
  });
});

describe("heartbeat schedule helpers", () => {
  it("matches step-based schedules in KST", () => {
    expect(matchesHeartbeatSchedule({
      minute: "*/15",
      hour: "*",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    }, new Date("2026-04-24T00:30:00Z"))).toBe(true);
    expect(matchesHeartbeatSchedule({
      minute: "*/15",
      hour: "*",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    }, new Date("2026-04-24T00:37:00Z"))).toBe(false);
  });

  it("supports weekday schedule matching", () => {
    expect(matchesHeartbeatSchedule({
      minute: "0",
      hour: "9-18",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "1-5",
    }, new Date("2026-04-24T00:00:00Z"))).toBe(true);
    expect(matchesHeartbeatSchedule({
      minute: "0",
      hour: "9-18",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "1-5",
    }, new Date("2026-04-26T00:00:00Z"))).toBe(false);
  });

  it("rejects invalid cron values", () => {
    expect(isValidHeartbeatSchedule({
      minute: "99",
      hour: "*",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    })).toBe(false);
  });

  it("builds a stable KST minute key", () => {
    expect(getKstMinuteKey(new Date("2026-04-24T00:30:00Z"))).toBe("2026-04-24T09:30");
  });

  it("migrates legacy single-heartbeat config into the new entries array", () => {
    const entries = normalizeHeartbeatEntries(undefined, {
      minute: "0",
      hour: "9",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "1-5",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].schedule.hour).toBe("9");
    expect(entries[0].agentId).toBe("monitor");
    expect(isValidHeartbeatEntries(entries)).toBe(true);
  });

  it("rejects heartbeat entry arrays larger than the cap", () => {
    expect(isValidHeartbeatEntries(Array.from({ length: 6 }, (_, index) => ({
      id: `heartbeat-${index}`,
      enabled: true,
      agentId: "monitor",
      schedule: {
        minute: "*/15",
        hour: "*",
        dayOfMonth: "*",
        month: "*",
        dayOfWeek: "*",
      },
    })))).toBe(false);
  });
});

describe("meetingSignal", () => {
  it("fires 10min before upcoming meeting once", () => {
    const shown = new Set<string>();
    const now = new Date("2026-04-18T09:00:00Z");
    const sig = createMeetingSignal({
      getEvents: () => [
        { subject: "Standup", start: "2026-04-18T09:08:00Z", end: "2026-04-18T09:30:00Z" },
      ],
      getShownSet: () => shown,
    });
    const r = sig.evaluate(now) as SignalResult;
    expect(r.fire).toBe(true);
    expect(r.reason).toContain("Standup");
    // dedupe
    expect(sig.evaluate(now)).toBeNull();
  });
  it("ignores all-day events and past events", () => {
    const sig = createMeetingSignal({
      getEvents: () => [
        { subject: "AllDay", start: "2026-04-18T00:00:00Z", end: "2026-04-18T23:59:59Z", isAllDay: true },
        { subject: "Past", start: "2026-04-17T00:00:00Z", end: "2026-04-17T01:00:00Z" },
      ],
      getShownSet: () => new Set(),
    });
    expect(sig.evaluate(new Date("2026-04-18T09:00:00Z"))).toBeNull();
  });
});

describe("taskDeadlineSignal", () => {
  it("fires for pending tasks due within 2h, dedupes by id", () => {
    const now = new Date("2026-04-18T09:00:00Z");
    const shown = new Set<string>();
    const sig = createTaskDeadlineSignal({
      getTasks: () => [
        { id: "t1", title: "Doc review", status: "pending", dueAt: "2026-04-18T10:00:00Z" },
      ],
      getShownSet: () => shown,
    });
    const r = sig.evaluate(now) as SignalResult;
    expect(r.fire).toBe(true);
    expect(sig.evaluate(now)).toBeNull();
  });
  it("ignores completed tasks and tasks without dueAt", () => {
    const sig = createTaskDeadlineSignal({
      getTasks: () => [
        { id: "t1", title: "Done", status: "completed", dueAt: "2026-04-18T10:00:00Z" },
        { id: "t2", title: "NoDue", status: "pending" },
      ],
      getShownSet: () => new Set(),
    });
    expect(sig.evaluate(new Date("2026-04-18T09:00:00Z"))).toBeNull();
  });
});

describe("RoutineTriggerCoordinator", () => {
  it("calls engine.generateDailyBriefing with idleState=triggered for non-idle signals", async () => {
    const { engine, calls } = fakeEngine();
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [{ name: "scheduleSignal", evaluate: () => ({ fire: true, reason: "schedule:08:30" }) }],
      disabled: () => false,
    });
    await coord._testEvaluate();
    expect(engine.generateDailyBriefing).toHaveBeenCalledTimes(1);
    expect(calls[0].idleState).toBe("triggered");
    expect(calls[0].triggerReason).toContain("scheduleSignal");
  });

  it("maps idleSignal → idleState=long_idle", async () => {
    const { engine, calls } = fakeEngine();
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [{ name: "idleSignal", evaluate: () => ({ fire: true, reason: "long_idle" }) }],
      disabled: () => false,
    });
    await coord._testEvaluate();
    expect(calls[0].idleState).toBe("long_idle");
  });

  it("forwards generated briefings to onBriefingGenerated", async () => {
    const onBriefingGenerated = vi.fn();
    const coord = new RoutineTriggerCoordinator({
      routineEngine: {
        generateDailyBriefing: vi.fn(async () => ({
          status: "generated",
          briefing: {
            generatedAt: "2026-04-24T00:00:00.000Z",
            items: [{ category: "system", priority: "low", title: "Wake up" }],
            summary: "Daily briefing",
          },
        })),
      } as any,
      evaluators: [{ name: "scheduleSignal", evaluate: () => ({ fire: true, reason: "schedule:08:30" }) }],
      onBriefingGenerated,
      disabled: () => false,
    });

    await coord._testEvaluate();

    expect(onBriefingGenerated).toHaveBeenCalledTimes(1);
    expect(onBriefingGenerated).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Daily briefing" }),
    );
  });

  it("debounces within 30min window", async () => {
    const { engine } = fakeEngine();
    let clock = new Date("2026-04-18T09:00:00Z");
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [{ name: "scheduleSignal", evaluate: () => ({ fire: true, reason: "x" }) }],
      disabled: () => false,
      now: () => clock,
    });
    await coord._testEvaluate();
    clock = new Date("2026-04-18T09:10:00Z");
    await coord._testEvaluate();
    expect(engine.generateDailyBriefing).toHaveBeenCalledTimes(1);
    // past 30min → fires again
    clock = new Date("2026-04-18T09:31:00Z");
    await coord._testEvaluate();
    expect(engine.generateDailyBriefing).toHaveBeenCalledTimes(2);
  });

  it("kill-switch disabled() blocks start()", () => {
    const { engine } = fakeEngine();
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [],
      disabled: () => true,
    });
    coord.start();
    coord.notify("anything");
    expect(engine.generateDailyBriefing).not.toHaveBeenCalled();
  });

  it("post-turn signal fires briefing only for explicit post-turn notifications", async () => {
    const { engine, calls } = fakeEngine();
    let lastFiredAt = 0;
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [
        createPostTurnSignal({
          getLastFiredAt: () => lastFiredAt,
          setLastFiredAt: (ts) => { lastFiredAt = ts; },
          isEnabled: () => true,
        }),
      ],
      disabled: () => false,
      debounceMs: 0,
    });
    await coord._testEvaluate("tick");
    expect(engine.generateDailyBriefing).not.toHaveBeenCalled();
    await coord._testEvaluate("event:post-turn");
    expect(engine.generateDailyBriefing).toHaveBeenCalledTimes(1);
    expect(calls[0].triggerReason).toContain("postTurnSignal");
  });

  it("post-turn signal skipped when disabled or within cooldown", async () => {
    const { engine } = fakeEngine();
    let lastFiredAt = Date.now(); // just fired
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [
        createPostTurnSignal({
          getCooldownMs: () => 600_000,
          getLastFiredAt: () => lastFiredAt,
          setLastFiredAt: (ts) => { lastFiredAt = ts; },
          isEnabled: () => true,
        }),
      ],
      disabled: () => false,
      debounceMs: 0,
    });
    await coord._testEvaluate();
    expect(engine.generateDailyBriefing).not.toHaveBeenCalled();

    // also skipped when isEnabled returns false
    const { engine: engine2 } = fakeEngine();
    let lastFiredAt2 = 0;
    const coord2 = new RoutineTriggerCoordinator({
      routineEngine: engine2,
      evaluators: [
        createPostTurnSignal({
          getLastFiredAt: () => lastFiredAt2,
          setLastFiredAt: (ts) => { lastFiredAt2 = ts; },
          isEnabled: () => false,
        }),
      ],
      disabled: () => false,
      debounceMs: 0,
    });
    await coord2._testEvaluate();
    expect(engine2.generateDailyBriefing).not.toHaveBeenCalled();
  });

  it("stops on first firing evaluator — no cascade", async () => {
    const { engine } = fakeEngine();
    const second = vi.fn(() => ({ fire: true, reason: "second" }));
    const coord = new RoutineTriggerCoordinator({
      routineEngine: engine,
      evaluators: [
        { name: "first", evaluate: () => ({ fire: true, reason: "first" }) },
        { name: "second", evaluate: second },
      ],
      disabled: () => false,
    });
    await coord._testEvaluate();
    expect(second).not.toHaveBeenCalled();
  });
});
