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

describe("ConversationActivityCoordinator onTurnSettled", () => {
  it("notifies after the lease is released, so a listener can start the next turn", async () => {
    const coordinator = createConversationActivityCoordinator();
    const busyWhenNotified: boolean[] = [];
    coordinator.onTurnSettled(() => busyWhenNotified.push(coordinator.isBusy()));

    await coordinator.trackTurn(async () => {});
    await coordinator.trackTurn(async () => {});
    expect(busyWhenNotified).toEqual([false, false]);
  });

  it("notifies for a turn that threw, and stops once unsubscribed", async () => {
    const coordinator = createConversationActivityCoordinator();
    let notified = 0;
    const unsubscribe = coordinator.onTurnSettled(() => { notified += 1; });

    await expect(coordinator.trackTurn(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(notified).toBe(1);

    unsubscribe();
    await coordinator.trackTurn(async () => {});
    expect(notified).toBe(1);
  });

  it("does not notify for a mutation lease — only turns end turns", async () => {
    const coordinator = createConversationActivityCoordinator();
    let notified = 0;
    coordinator.onTurnSettled(() => { notified += 1; });
    await coordinator.trackMutation(async () => {});
    expect(notified).toBe(0);
  });
});
