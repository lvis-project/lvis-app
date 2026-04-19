/**
 * Issue 3 fix — double-briefing race prevention via shared global cooldown.
 *
 * Verifies:
 * - IDLE_SCAN fires → 1 briefing generated.
 * - Post-turn notify 1 minute later → no-op (within 10-min global cooldown).
 * - isWithinGlobalCooldown() helper returns correct state.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ProactiveTriggerCoordinator,
  createIdleSignal,
  createPostTurnSignal,
} from "../../core/proactive-trigger-coordinator.js";
import type { ProactiveEngine } from "../../core/proactive-engine.js";

function makeMockEngine(status: "generated" | "skipped" = "generated") {
  const calls: unknown[] = [];
  const engine = {
    generateDailyBriefing: vi.fn(async (opts: unknown) => {
      calls.push(opts);
      return status === "generated"
        ? { status: "generated", briefing: { generatedAt: new Date().toISOString(), items: [], summary: "" } }
        : { status: "skipped", reason: "already-generated" };
    }),
    _calls: calls,
  } as unknown as ProactiveEngine & { _calls: unknown[] };
  return engine;
}

describe("ProactiveTriggerCoordinator — global cooldown (Issue 3)", () => {
  it("IDLE_SCAN fires briefing; post-turn 1 min later is suppressed by global cooldown", async () => {
    let nowMs = Date.now();
    let isIdle = false;
    let postTurnLastFiredAt = 0;

    const engine = makeMockEngine("generated");

    const coordinator = new ProactiveTriggerCoordinator({
      proactiveEngine: engine,
      disabled: () => false,
      debounceMs: 10 * 60_000, // 10 min
      tickIntervalMs: 999_999, // disable auto-tick
      now: () => new Date(nowMs),
      evaluators: [
        createIdleSignal(() => isIdle),
        createPostTurnSignal({
          getCooldownMs: () => 10 * 60_000,
          getLastFiredAt: () => postTurnLastFiredAt,
          setLastFiredAt: (ts) => { postTurnLastFiredAt = ts; },
          isEnabled: () => true,
        }),
      ],
    });

    // Step 1: IDLE_SCAN fires
    isIdle = true;
    const result1 = await coordinator._testEvaluate("idle");
    expect(result1?.fire).toBe(true);
    expect(engine.generateDailyBriefing).toHaveBeenCalledTimes(1);

    // Step 2: advance clock by 1 minute (within 10-min cooldown)
    nowMs += 60_000;
    isIdle = false;

    // Post-turn notify — within global cooldown → should be suppressed
    const result2 = await coordinator._testEvaluate("post-turn");
    expect(result2).toBeNull(); // coordinator debounce blocks this
    expect(engine.generateDailyBriefing).toHaveBeenCalledTimes(1); // still only 1 briefing
  });

  it("isWithinGlobalCooldown returns true immediately after a fire", async () => {
    let isIdle = true;
    const engine = makeMockEngine("generated");

    const coordinator = new ProactiveTriggerCoordinator({
      proactiveEngine: engine,
      disabled: () => false,
      debounceMs: 10 * 60_000,
      tickIntervalMs: 999_999,
      evaluators: [createIdleSignal(() => isIdle)],
    });

    expect(coordinator.isWithinGlobalCooldown()).toBe(false);

    await coordinator._testEvaluate("idle");

    expect(coordinator.isWithinGlobalCooldown()).toBe(true);
    // With a very short window (0ms), cooldown should report false since time has advanced
    expect(coordinator.isWithinGlobalCooldown(0)).toBe(false);
  });

  it("isWithinGlobalCooldown returns false when no briefing has fired", () => {
    const engine = makeMockEngine("skipped");
    const coordinator = new ProactiveTriggerCoordinator({
      proactiveEngine: engine,
      disabled: () => false,
      debounceMs: 10 * 60_000,
      tickIntervalMs: 999_999,
      evaluators: [],
    });

    expect(coordinator.isWithinGlobalCooldown()).toBe(false);
    expect(coordinator.isWithinGlobalCooldown(10 * 60_000)).toBe(false);
  });
});
