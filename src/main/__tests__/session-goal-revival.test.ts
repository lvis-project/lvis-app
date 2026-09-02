/**
 * Session-goal revival — the loop and, one by one, everything that stops it.
 *
 * The driver is exercised through the same seam production wires it through:
 * a turn lease that settles, a session id the group is holding, and a store
 * over an in-memory sidecar. No window, no provider, no Electron.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionGoalRevival } from "../session-goal-revival.js";
import { SESSION_GOAL_CEILING } from "../../shared/session-goal.js";
import { makeSessionGoalStore } from "../../__tests__/test-helpers.js";

const SESSION = "session-a";

function harness(overrides: {
  currentSessionId?: () => string;
  isAttached?: () => boolean;
  hasActiveTurn?: () => boolean;
} = {}) {
  const { store: goals, disk } = makeSessionGoalStore();
  const turns: Array<{ input: string; displayText: string }> = [];
  let leaseHeld = false;
  const runTurn = vi.fn(async (turn: { input: string; displayText: string }) => {
    turns.push(turn);
  });
  const revival = createSessionGoalRevival({
    goals,
    currentSessionId: overrides.currentSessionId ?? (() => SESSION),
    isAttached: overrides.isAttached ?? (() => true),
    isBusy: () => leaseHeld,
    hasActiveTurn: overrides.hasActiveTurn ?? (() => false),
    tryTakeTurn: (body) => {
      if (leaseHeld) return null;
      leaseHeld = true;
      return body().finally(() => {
        leaseHeld = false;
      });
    },
    runTurn,
  });
  /** One turn ending, awaited to its settled state. */
  const settle = async () => {
    revival.reviveIfDue();
    // The driver's work is a chain of microtasks behind the lease; two ticks
    // is enough for one revival to finish and for its own settle NOT to be
    // implied (production re-enters through the coordinator, not from here).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  // The goal-change trigger and the settled-turn trigger are the same
  // evaluation; naming both makes the tests say which one they mean.
  return { goals, turns, runTurn, settle, revive: settle, disk };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("session goal revival", () => {
  it("does nothing when the session has no goal", async () => {
    const h = harness();
    await h.settle();
    expect(h.runTurn).not.toHaveBeenCalled();
  });

  it("revives with the round advancing on every settled turn", async () => {
    const h = harness();
    await h.goals.set(SESSION, "ship it");
    await h.settle();
    await h.settle();
    await h.settle();
    expect(h.turns).toHaveLength(3);
    expect(h.turns.map((t) => t.displayText)).toEqual([
      `목표 계속 진행 1/${SESSION_GOAL_CEILING}`,
      `목표 계속 진행 2/${SESSION_GOAL_CEILING}`,
      `목표 계속 진행 3/${SESSION_GOAL_CEILING}`,
    ]);
    expect(h.turns[0]!.input).toContain("ship it");
    expect(h.goals.get(SESSION)?.round).toBe(3);
  });

  it("stops once the goal is marked complete", async () => {
    const h = harness();
    await h.goals.set(SESSION, "ship it");
    await h.settle();
    await h.goals.complete(SESSION);
    await h.settle();
    expect(h.turns).toHaveLength(1);
  });

  it("stops while the goal is paused and continues from the same round", async () => {
    const h = harness();
    await h.goals.set(SESSION, "ship it");
    await h.settle();
    await h.goals.pause(SESSION);
    await h.settle();
    await h.settle();
    expect(h.turns).toHaveLength(1);

    await h.goals.resume(SESSION);
    await h.settle();
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1]!.displayText).toBe(`목표 계속 진행 2/${SESSION_GOAL_CEILING}`);
  });

  it("starts on a resume, without waiting for a turn to end first", async () => {
    // A resume while the session sits idle has no turn to follow. If the only
    // trigger were a settled turn, the button would move the chip and change
    // nothing until the user typed again — a no-op with a label.
    const h = harness();
    await h.goals.set(SESSION, "ship it");
    await h.settle();
    await h.goals.pause(SESSION);
    expect(h.turns).toHaveLength(1);

    await h.goals.resume(SESSION);
    await h.revive();
    expect(h.turns).toHaveLength(2);
  });

  it("stops at the ceiling instead of silently continuing", async () => {
    const h = harness();
    await h.goals.set(SESSION, "ship it");
    for (let i = 0; i < SESSION_GOAL_CEILING + 5; i += 1) await h.settle();
    expect(h.turns).toHaveLength(SESSION_GOAL_CEILING);
    expect(h.goals.get(SESSION)?.round).toBe(SESSION_GOAL_CEILING);
  });

  it("continues past the ceiling only when the user resumes it", async () => {
    const h = harness();
    await h.goals.set(SESSION, "ship it");
    for (let i = 0; i < SESSION_GOAL_CEILING + 2; i += 1) await h.settle();
    expect(h.turns).toHaveLength(SESSION_GOAL_CEILING);

    await h.goals.resume(SESSION);
    await h.settle();
    expect(h.turns).toHaveLength(SESSION_GOAL_CEILING + 1);
  });

  it("does not revive a session the group is no longer holding", async () => {
    let holding = SESSION;
    const h = harness({ currentSessionId: () => holding });
    await h.goals.set(SESSION, "ship it");
    holding = "another-session";
    await h.settle();
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(h.goals.get(SESSION)?.round).toBe(0);
  });

  it("does not revive once the tile is released or the window is gone", async () => {
    let attached = true;
    const h = harness({ isAttached: () => attached });
    await h.goals.set(SESSION, "ship it");
    attached = false;
    await h.settle();
    expect(h.runTurn).not.toHaveBeenCalled();
  });

  it("does not stack a revival on a turn that is already running", async () => {
    const h = harness({ hasActiveTurn: () => true });
    await h.goals.set(SESSION, "ship it");
    await h.settle();
    expect(h.runTurn).not.toHaveBeenCalled();
  });

  it("spends the round even when the revival turn fails, and keeps going", async () => {
    const h = harness();
    await h.goals.set(SESSION, "ship it");
    h.runTurn.mockRejectedValueOnce(new Error("provider down"));
    await h.settle();
    expect(h.goals.get(SESSION)?.round).toBe(1);
    await h.settle();
    expect(h.goals.get(SESSION)?.round).toBe(2);
  });
});
