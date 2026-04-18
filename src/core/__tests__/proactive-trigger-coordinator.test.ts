/**
 * Sprint 3-A-2 — ProactiveTriggerCoordinator unit tests.
 * Each signal has dedicated coverage; coordinator-level debounce + disabled
 * kill switch validated.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ProactiveTriggerCoordinator,
  createIdleSignal,
  createScheduleSignal,
  createMeetingSignal,
  createTaskDeadlineSignal,
  type SignalResult,
} from "../proactive-trigger-coordinator.js";

function fakeEngine() {
  const calls: Array<{ idleState?: string; triggerReason?: string }> = [];
  return {
    calls,
    engine: {
      // cast via unknown to sidestep the full ProactiveEngine surface
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
      isEnabled: () => false,
      getLastFiredDayKey: () => undefined,
      setLastFiredDayKey: () => {},
    });
    expect(sig.evaluate(new Date("2026-04-17T23:31:00Z"))).toBeNull();
  });
  it("does not fire outside target window", () => {
    const sig = createScheduleSignal({
      isEnabled: () => true,
      getLastFiredDayKey: () => undefined,
      setLastFiredDayKey: () => {},
    });
    // 10:00 KST = 01:00 UTC
    expect(sig.evaluate(new Date("2026-04-18T01:00:00Z"))).toBeNull();
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

describe("ProactiveTriggerCoordinator", () => {
  it("calls engine.generateDailyBriefing with idleState=triggered for non-idle signals", async () => {
    const { engine, calls } = fakeEngine();
    const coord = new ProactiveTriggerCoordinator({
      proactiveEngine: engine,
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
    const coord = new ProactiveTriggerCoordinator({
      proactiveEngine: engine,
      evaluators: [{ name: "idleSignal", evaluate: () => ({ fire: true, reason: "long_idle" }) }],
      disabled: () => false,
    });
    await coord._testEvaluate();
    expect(calls[0].idleState).toBe("long_idle");
  });

  it("debounces within 30min window", async () => {
    const { engine } = fakeEngine();
    let clock = new Date("2026-04-18T09:00:00Z");
    const coord = new ProactiveTriggerCoordinator({
      proactiveEngine: engine,
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
    const coord = new ProactiveTriggerCoordinator({
      proactiveEngine: engine,
      evaluators: [],
      disabled: () => true,
    });
    coord.start();
    coord.notify("anything");
    expect(engine.generateDailyBriefing).not.toHaveBeenCalled();
  });

  it("stops on first firing evaluator — no cascade", async () => {
    const { engine } = fakeEngine();
    const second = vi.fn(() => ({ fire: true, reason: "second" }));
    const coord = new ProactiveTriggerCoordinator({
      proactiveEngine: engine,
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
