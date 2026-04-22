/**
 * Sprint 2-D — IdleScheduler ↔ RoutineEngine trigger wiring test.
 *
 * Verifies that when the host wires
 *   idleScheduler.setStateChangeListener(newState =>
 *     proactiveEngine.generateDailyBriefing({ idleState: "long_idle" })
 *   )
 * a IDLE_SCAN transition fires exactly one generateDailyBriefing() call and
 * the underlying callLlm is invoked once (flag=on, no prior briefing today).
 */
import { describe, it, expect, vi } from "vitest";
import { IdleSchedulerService, type WorkerClientLite } from "../idle-scheduler.js";
import { RoutineEngine } from "../../core/routine-engine.js";

function makeNoopWorker(): WorkerClientLite {
  return {
    enqueue: async () => ({ queued: true, queue_size: 0 }),
    processOne: async () => ({ processed: false }),
    getIndexerState: async () => ({ queue_size: 0, processed: 0, failed: 0, enqueued: 0 }),
  };
}

describe("Sprint 2-D: idle IDLE_SCAN transition triggers daily briefing", () => {
  it("invokes generateDailyBriefing once when entering IDLE_SCAN (flag=on)", async () => {
    const callLlm = vi.fn().mockResolvedValue("테스트 브리핑 요약");
    const setLastBriefingDate = vi.fn();
    const engine = new RoutineEngine({
      getTaskSummary: () => [
        { title: "테스트 태스크", priority: "high", status: "pending", source: "test" },
      ],
      getRecentNotes: () => [],
      getRecentSessions: () => [],
      isDailyBriefingEnabled: () => true,
      callLlm,
      getLastBriefingDate: () => undefined,
      setLastBriefingDate,
      getLastDismissedAt: () => undefined,
    });

    const generateSpy = vi.spyOn(engine, "generateDailyBriefing");

    const sched = new IdleSchedulerService({
      workerClient: makeNoopWorker(),
      tickIntervalMs: 1_000_000,
      chunkCooldownMs: 0,
      throttledCooldownMs: 0,
      logger: () => { /* silent */ },
    });

    // boot.ts-style wiring: IDLE_SCAN → long_idle
    sched.setStateChangeListener((newState) => {
      if (newState !== "IDLE_SCAN") return;
      void engine.generateDailyBriefing({ idleState: "long_idle" });
    });

    // Force the transition that boot.ts relies on.
    sched._testForceTransition("IDLE_SCAN", "test");

    // Flush microtasks so the void promise from the listener resolves.
    await new Promise<void>((r) => setImmediate(r));

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy).toHaveBeenCalledWith({ idleState: "long_idle" });
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(setLastBriefingDate).toHaveBeenCalledTimes(1);
  });

  it("does not invoke generateDailyBriefing on non-IDLE_SCAN transitions", async () => {
    const callLlm = vi.fn().mockResolvedValue("x");
    const engine = new RoutineEngine({
      getTaskSummary: () => [
        { title: "t", priority: "high", status: "pending", source: "test" },
      ],
      getRecentNotes: () => [],
      getRecentSessions: () => [],
      isDailyBriefingEnabled: () => true,
      callLlm,
    });
    const generateSpy = vi.spyOn(engine, "generateDailyBriefing");

    const sched = new IdleSchedulerService({
      workerClient: makeNoopWorker(),
      tickIntervalMs: 1_000_000,
      logger: () => { /* silent */ },
    });

    sched.setStateChangeListener((newState) => {
      if (newState !== "IDLE_SCAN") return;
      void engine.generateDailyBriefing({ idleState: "long_idle" });
    });

    sched._testForceTransition("THROTTLED", "test");
    sched._testForceTransition("PAUSED", "test");
    await new Promise<void>((r) => setImmediate(r));

    expect(generateSpy).not.toHaveBeenCalled();
    expect(callLlm).not.toHaveBeenCalled();
  });
});
