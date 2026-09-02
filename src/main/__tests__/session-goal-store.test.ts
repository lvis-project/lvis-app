/**
 * SessionGoalStore — upsert semantics, the revival budget, and the sidecar
 * round trip that makes the budget survive a restart.
 */
import { describe, expect, it } from "vitest";
import {
  SessionGoalMissingError,
  SessionGoalStore,
  SessionGoalTextError,
} from "../session-goal-store.js";
import { SESSION_GOAL_CEILING, type SessionGoal } from "../../shared/session-goal.js";
import { makeSessionGoalStore } from "../../__tests__/test-helpers.js";

const SESSION = "session-a";

function memoryStore() {
  let tick = 0;
  return makeSessionGoalStore(
    () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  );
}

describe("SessionGoalStore", () => {
  it("sets a goal with a fresh budget when there is none", async () => {
    const { store } = memoryStore();
    const goal = await store.set(SESSION, "  ship the release  ");
    expect(goal).toMatchObject({
      text: "ship the release",
      status: "running",
      round: 0,
      ceiling: SESSION_GOAL_CEILING,
    });
  });

  it("updates the text of an existing goal without refunding spent rounds", async () => {
    const { store } = memoryStore();
    await store.set(SESSION, "first");
    await store.recordRevival(SESSION);
    await store.recordRevival(SESSION);
    const goal = await store.set(SESSION, "second");
    expect(goal.text).toBe("second");
    expect(goal.round).toBe(2);
    expect(goal.ceiling).toBe(SESSION_GOAL_CEILING);
  });

  it("restarts a paused goal when a new text is registered", async () => {
    const { store } = memoryStore();
    await store.set(SESSION, "first");
    await store.pause(SESSION);
    expect((await store.set(SESSION, "second")).status).toBe("running");
  });

  // Refused BEFORE any await, like SessionTasksStore's index errors: the
  // caller learns the input is wrong without a sidecar round trip.
  it("refuses empty and oversized goal text", () => {
    const { store } = memoryStore();
    expect(() => store.set(SESSION, "   ")).toThrow(SessionGoalTextError);
    expect(() => store.set(SESSION, "x".repeat(2001))).toThrow(SessionGoalTextError);
  });

  it("refuses a status change on a session that has no goal", () => {
    const { store } = memoryStore();
    expect(() => store.pause(SESSION)).toThrow(SessionGoalMissingError);
    expect(() => store.complete(SESSION)).toThrow(SessionGoalMissingError);
    expect(() => store.resume(SESSION)).toThrow(SessionGoalMissingError);
    expect(() => store.recordRevival(SESSION)).toThrow(SessionGoalMissingError);
  });

  it("resumes from the round it paused at", async () => {
    const { store } = memoryStore();
    await store.set(SESSION, "goal");
    await store.recordRevival(SESSION);
    await store.recordRevival(SESSION);
    await store.pause(SESSION);
    const resumed = await store.resume(SESSION);
    expect(resumed.status).toBe("running");
    expect(resumed.round).toBe(2);
    expect(resumed.ceiling).toBe(SESSION_GOAL_CEILING);
  });

  it("extends the ceiling when resuming a goal whose budget is spent", async () => {
    const { store } = memoryStore();
    await store.set(SESSION, "goal");
    for (let i = 0; i < SESSION_GOAL_CEILING; i += 1) await store.recordRevival(SESSION);
    const resumed = await store.resume(SESSION);
    expect(resumed.round).toBe(SESSION_GOAL_CEILING);
    expect(resumed.ceiling).toBe(SESSION_GOAL_CEILING * 2);
  });

  it("brings the goal and its spent rounds back from the sidecar", async () => {
    const { disk, store } = memoryStore();
    await store.set(SESSION, "goal");
    await store.recordRevival(SESSION);
    await store.recordRevival(SESSION);
    await store.recordRevival(SESSION);

    // A second store over the same disk is what a restart looks like.
    const restarted = new SessionGoalStore({
      load: (sid) => disk.get(sid) ?? null,
      save: async (sid, goal) => {
        disk.set(sid, goal);
      },
    });
    expect(restarted.get(SESSION)).toMatchObject({
      text: "goal",
      status: "running",
      round: 3,
      ceiling: SESSION_GOAL_CEILING,
    });
  });

  it("keeps memory behind a failed sidecar write", async () => {
    const store = new SessionGoalStore({
      load: () => null,
      save: async () => {
        throw new Error("disk full");
      },
    });
    await expect(store.set(SESSION, "goal")).rejects.toThrow("disk full");
    expect(store.get(SESSION)).toBeNull();
  });

  it("emits every change and the absence left by a clear", async () => {
    const { store } = memoryStore();
    const seen: Array<SessionGoal | null> = [];
    store.onChange((_sid, goal) => seen.push(goal));
    await store.set(SESSION, "goal");
    await store.complete(SESSION);
    await store.clear(SESSION);
    expect(seen.map((g) => g?.status ?? null)).toEqual(["running", "complete", null]);
    expect(store.get(SESSION)).toBeNull();
  });
});
