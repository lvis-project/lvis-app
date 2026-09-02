/**
 * `/goal` — the user's way into the same upsert the `session_goal` tool
 * performs, dispatched from the main-process slash switch.
 *
 * The command is keyboard-origin only, like every other command in that
 * switch; and it registers a goal on the session the loop is holding, which
 * is what makes the next settled turn revive.
 */
import { describe, expect, it } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import { makeConversationLoopDeps } from "./conversation-loop-test-helpers.js";
import type { SessionGoalStore } from "../../main/session-goal-store.js";
import { SESSION_GOAL_CEILING } from "../../shared/session-goal.js";
import { makeSessionGoalStore } from "../../__tests__/test-helpers.js";

function makeLoop(sessionGoalStore?: SessionGoalStore): ConversationLoop {
  const loop = new ConversationLoop(
    makeConversationLoopDeps(sessionGoalStore ? { sessionGoalStore } : {}),
  );
  loop.newConversation("main");
  return loop;
}


describe("/goal", () => {
  it("registers the goal on the session the loop is holding", async () => {
    const store = makeSessionGoalStore().store;
    const loop = makeLoop(store);
    const result = await loop.handleCommand("goal", "  ship the release  ", "user-keyboard");
    expect(result.route).toBe("command");
    expect(result.text).toContain("ship the release");
    expect(store.get(loop.sessionId)).toMatchObject({
      text: "ship the release",
      status: "running",
      round: 0,
      ceiling: SESSION_GOAL_CEILING,
    });
  });

  it("reports the current goal and its round when called with no text", async () => {
    const store = makeSessionGoalStore().store;
    const loop = makeLoop(store);
    await loop.handleCommand("goal", "ship it", "user-keyboard");
    await store.recordRevival(loop.sessionId);
    const result = await loop.handleCommand("goal", "", "user-keyboard");
    expect(result.text).toContain("ship it");
    expect(result.text).toContain("running");
    expect(result.text).toContain(`1`);
  });

  it("explains how to use it when there is no goal and no text", async () => {
    const result = await makeLoop(makeSessionGoalStore().store).handleCommand("goal", "", "user-keyboard");
    expect(result.text).toContain("/goal");
  });

  it("reports the refusal rather than registering an unusable goal", async () => {
    const store = makeSessionGoalStore().store;
    const loop = makeLoop(store);
    const result = await loop.handleCommand("goal", "x".repeat(2001), "user-keyboard");
    expect(result.text).toContain("2000");
    expect(store.get(loop.sessionId)).toBeNull();
  });

  it("says so on a conversation that has no revival driver", async () => {
    const result = await makeLoop().handleCommand("goal", "ship it", "user-keyboard");
    expect(result.text).toContain("메인 채팅");
  });

  it("is refused from a non-keyboard origin, like every other slash command", async () => {
    const store = makeSessionGoalStore().store;
    const loop = makeLoop(store);
    await loop.handleCommand("goal", "ship it", "agent-message");
    expect(store.get(loop.sessionId)).toBeNull();
  });
});
