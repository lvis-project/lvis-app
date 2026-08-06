import { describe, expect, it } from "vitest";
import { createConversationActivityCoordinator } from "../conversation-activity-coordinator.js";

describe("ConversationActivityCoordinator", () => {
  it("uses one turn lease across all callers and releases it after completion", async () => {
    const coordinator = createConversationActivityCoordinator();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = coordinator.trackTurn(async () => {
      await waiting;
      return "first";
    });

    await expect(coordinator.trackTurn(async () => "second")).rejects.toThrow("streaming-active");
    expect(coordinator.trackMutation(async () => "mutate")).toBeNull();

    release();
    await expect(first).resolves.toBe("first");
    await expect(coordinator.trackTurn(async () => "third")).resolves.toBe("third");
  });

  it("publishes a mutation lease before deferred work can re-enter", async () => {
    const coordinator = createConversationActivityCoordinator();
    let reentrant: Promise<unknown> | undefined;

    const mutation = coordinator.trackMutation(async () => {
      reentrant = coordinator.trackTurn(async () => "turn");
      return "mutation";
    });

    expect(mutation).not.toBeNull();
    await expect(mutation).resolves.toBe("mutation");
    await expect(reentrant).rejects.toThrow("streaming-active");
  });

  it("allocates stable process-wide stream ids", () => {
    const coordinator = createConversationActivityCoordinator();
    expect(coordinator.allocateStreamId()).toBe(1);
    expect(coordinator.allocateStreamId()).toBe(2);
  });
});

describe("ConversationActivityCoordinator tryTrackTurn", () => {
  it("fails before a state-changing factory can run", async () => {
    const coordinator = createConversationActivityCoordinator();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coordinator.trackTurn(async () => {
      await waiting;
    });
    let changedState = false;

    expect(coordinator.tryTrackTurn(async () => {
      changedState = true;
    })).toBeNull();
    expect(changedState).toBe(false);

    release();
    await first;
  });
});
