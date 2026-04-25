/**
 * RoutineIdleSignaler — unit tests with FakePowerMonitor + injected clock/timer.
 *
 * Verifies:
 *   - lock → unlock above threshold emits idle-long-exit (wakeup trigger)
 *   - lock → unlock below threshold does NOT emit (noise filter)
 *   - tick polling: long systemIdleTime → idle-long-entry, drop → exit
 *   - cooldown suppresses rapid duplicate emissions
 *   - suspend/resume mirrors lock/unlock behavior
 *   - threshold getter reads on each evaluation (live setting changes)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RoutineIdleSignaler, type IdleSignalEvent } from "../idle-signaler.js";
import type { PowerMonitorLike } from "../../main/idle-scheduler.js";

class FakePowerMonitor implements PowerMonitorLike {
  systemIdleSec = 0;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  getSystemIdleTime(): number {
    return this.systemIdleSec;
  }

  on(event: string, handler: (...args: unknown[]) => void): unknown {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return this;
  }

  off(event: string, handler: (...args: unknown[]) => void): unknown {
    const hs = this.handlers.get(event);
    if (hs) this.handlers.set(event, hs.filter((h) => h !== handler));
    return this;
  }

  removeAllListeners(event?: string): unknown {
    if (event) this.handlers.delete(event);
    else this.handlers.clear();
    return this;
  }

  fire(event: string): void {
    for (const h of this.handlers.get(event) ?? []) h();
  }
}

interface Harness {
  pm: FakePowerMonitor;
  signaler: RoutineIdleSignaler;
  events: Array<{ event: IdleSignalEvent; reason: string }>;
  /** Move the injected clock forward by `ms`; does NOT auto-tick the poll. */
  advance(ms: number): void;
  /** Manually drive a poll tick (the test-only setInterval is a no-op). */
  tick(): void;
  /** Current injected wall clock (ms). */
  now(): number;
}

function makeHarness(opts: {
  thresholdMs?: number;
  cooldownMs?: number;
} = {}): Harness {
  const pm = new FakePowerMonitor();
  const events: Array<{ event: IdleSignalEvent; reason: string }> = [];
  let clock = 1_000_000;
  const signaler = new RoutineIdleSignaler({
    powerMonitor: pm,
    getLongIdleThresholdMs: () => opts.thresholdMs ?? 10 * 60_000,
    perEventCooldownMs: opts.cooldownMs ?? 60_000,
    pollIntervalMs: 30_000,
    now: () => clock,
    setIntervalImpl: () => 1, // no auto-tick; tests call _testTick()
    clearIntervalImpl: () => {},
    logger: () => {},
  });
  signaler.on((event, reason) => events.push({ event, reason }));
  signaler.start();
  return {
    pm,
    signaler,
    events,
    advance: (ms) => { clock += ms; },
    tick: () => signaler._testTick(),
    now: () => clock,
  };
}

describe("RoutineIdleSignaler — lock/unlock", () => {
  it("lock then unlock after threshold emits idle-long-exit", () => {
    const h = makeHarness({ thresholdMs: 10 * 60_000 });
    h.pm.fire("lock-screen");
    h.advance(11 * 60_000);
    // tick during idle window flips presence to idle-long
    h.pm.systemIdleSec = 11 * 60;
    h.tick();
    h.pm.fire("unlock-screen");

    const exitEvents = h.events.filter((e) => e.event === "idle-long-exit");
    expect(exitEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("lock then quick unlock below threshold does NOT emit exit", () => {
    const h = makeHarness({ thresholdMs: 10 * 60_000 });
    h.pm.fire("lock-screen");
    h.advance(2 * 60_000); // 2 min — below threshold
    h.pm.fire("unlock-screen");

    expect(h.events.find((e) => e.event === "idle-long-exit")).toBeUndefined();
    // also no entry, since tick never observed long idle
    expect(h.events.find((e) => e.event === "idle-long-entry")).toBeUndefined();
  });

  it("unlock without prior lock is a no-op", () => {
    const h = makeHarness();
    h.pm.fire("unlock-screen");
    expect(h.events.length).toBe(0);
  });
});

describe("RoutineIdleSignaler — tick polling", () => {
  it("tick with long systemIdleTime emits idle-long-entry then exit on drop", () => {
    const h = makeHarness({ thresholdMs: 10 * 60_000, cooldownMs: 0 });
    h.pm.systemIdleSec = 11 * 60;
    h.tick();
    expect(h.events[0]).toMatchObject({ event: "idle-long-entry" });

    // user activity; idle resets
    h.advance(120_000);
    h.pm.systemIdleSec = 5;
    h.tick();
    const exit = h.events.find((e) => e.event === "idle-long-exit");
    expect(exit).toBeTruthy();
  });

  it("tick with idle below threshold does not emit", () => {
    const h = makeHarness({ thresholdMs: 10 * 60_000 });
    h.pm.systemIdleSec = 60;
    h.tick();
    expect(h.events.length).toBe(0);
  });
});

describe("RoutineIdleSignaler — cooldown", () => {
  it("suppresses repeated entry emissions within cooldown window", () => {
    const h = makeHarness({ thresholdMs: 10 * 60_000, cooldownMs: 60_000 });
    h.pm.systemIdleSec = 11 * 60;
    h.tick();
    expect(h.events.filter((e) => e.event === "idle-long-entry").length).toBe(1);

    // user activity briefly, then immediately back to idle
    h.advance(1000);
    h.pm.systemIdleSec = 5;
    h.tick();
    h.advance(1000);
    h.pm.systemIdleSec = 11 * 60;
    h.tick();
    // second entry within cooldown is suppressed
    expect(h.events.filter((e) => e.event === "idle-long-entry").length).toBe(1);
  });
});

describe("RoutineIdleSignaler — suspend/resume", () => {
  it("suspend then resume after threshold emits idle-long-exit", () => {
    const h = makeHarness({ thresholdMs: 10 * 60_000 });
    h.pm.fire("suspend");
    h.advance(11 * 60_000);
    h.pm.systemIdleSec = 11 * 60;
    h.tick(); // promote to idle-long
    h.pm.fire("resume");
    expect(h.events.find((e) => e.event === "idle-long-exit")).toBeTruthy();
  });

  it("suspend then quick resume below threshold does NOT emit exit", () => {
    const h = makeHarness({ thresholdMs: 10 * 60_000 });
    h.pm.fire("suspend");
    h.advance(60_000); // 1 min
    h.pm.fire("resume");
    expect(h.events.find((e) => e.event === "idle-long-exit")).toBeUndefined();
  });
});

describe("RoutineIdleSignaler — threshold live read", () => {
  it("getLongIdleThresholdMs is evaluated on each tick (live settings change)", () => {
    let threshold = 60 * 60_000; // 1 hour initially
    const events: Array<{ event: IdleSignalEvent; reason: string }> = [];
    const pm = new FakePowerMonitor();
    let clock = 1_000_000;
    const signaler = new RoutineIdleSignaler({
      powerMonitor: pm,
      getLongIdleThresholdMs: () => threshold,
      perEventCooldownMs: 0,
      pollIntervalMs: 30_000,
      now: () => clock,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
      logger: () => {},
    });
    signaler.on((e, r) => events.push({ event: e, reason: r }));
    signaler.start();

    pm.systemIdleSec = 11 * 60; // 11 min — below 1 hour threshold
    signaler._testTick();
    expect(events.find((e) => e.event === "idle-long-entry")).toBeUndefined();

    // Lower threshold to 5 min — same idle now exceeds it
    threshold = 5 * 60_000;
    signaler._testTick();
    expect(events.find((e) => e.event === "idle-long-entry")).toBeTruthy();
  });
});

describe("RoutineIdleSignaler — disabled kill switch", () => {
  it("disabled returns true → start is no-op, no events", () => {
    const pm = new FakePowerMonitor();
    let clock = 1_000_000;
    const events: unknown[] = [];
    const signaler = new RoutineIdleSignaler({
      powerMonitor: pm,
      getLongIdleThresholdMs: () => 10 * 60_000,
      perEventCooldownMs: 0,
      pollIntervalMs: 30_000,
      now: () => clock,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
      logger: () => {},
      disabled: () => true,
    });
    signaler.on((e, r) => events.push({ event: e, reason: r }));
    signaler.start();
    pm.systemIdleSec = 11 * 60;
    pm.fire("lock-screen");
    pm.fire("unlock-screen");
    expect(events.length).toBe(0);
  });
});

describe("RoutineIdleSignaler — registry buildRoutineForTrigger", () => {
  it("registry helper integrates with normalized settings (smoke)", async () => {
    const { buildRoutineForTrigger } = await import("../registry.js");
    const built = buildRoutineForTrigger("wakeup", { enableWakeupRoutine: true, wakeupRoutinePrompt: "hello" });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.routine.id).toBe("wakeup");
      expect(built.routine.prePrompt).toBe("hello");
    }
  });
});
