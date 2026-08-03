import { describe, expect, it } from "vitest";
import { createConversationTurnRegistry } from "../conversation-turn-registry.js";

describe("ConversationTurnRegistry", () => {
  it("allows only the owning actor to cancel its one live public turn", () => {
    const registry = createConversationTurnRegistry();
    const abortController = new AbortController();
    const registration = registry.register({
      turnId: "tailnet-turn-1",
      actorId: "tailnet:owner",
      abortController,
      isCurrent: () => true,
    });

    expect(registration).not.toBeNull();
    expect(registry.cancelOwned("tailnet:other", "tailnet-turn-1")).toBe("not-owner");
    expect(abortController.signal.aborted).toBe(false);
    expect(registry.cancelOwned("tailnet:owner", "tailnet-turn-1")).toBe("cancel-requested");
    expect(abortController.signal.aborted).toBe(true);
    expect(registry.cancelOwned("tailnet:owner", "tailnet-turn-1")).toBe("cancel-requested");

    registration!.complete();
    expect(registry.cancelOwned("tailnet:owner", "tailnet-turn-1")).toBe("not-active");
  });

  it("does not let a stale completion remove a newer registration", () => {
    const registry = createConversationTurnRegistry();
    const first = registry.register({
      turnId: "turn-one",
      actorId: "actor-one",
      abortController: new AbortController(),
      isCurrent: () => true,
    });
    first!.complete();
    const second = registry.register({
      turnId: "turn-two",
      actorId: "actor-two",
      abortController: new AbortController(),
      isCurrent: () => true,
    });

    first!.complete();
    expect(registry.hasActiveTurn("turn-two")).toBe(true);
    second!.complete();
    expect(registry.hasActiveTurn("turn-two")).toBe(false);
  });

  it("aborts a public turn when its paired binding becomes stale", () => {
    const registry = createConversationTurnRegistry();
    const abortController = new AbortController();
    let current = true;
    const registration = registry.register({
      turnId: "tailnet-turn-stale",
      actorId: "tailnet:owner",
      abortController,
      isCurrent: () => current,
    });

    expect(registration).not.toBeNull();
    current = false;
    registry.invalidateStale();
    expect(abortController.signal.aborted).toBe(true);
    // The shared activity lease remains live until the aborted execution settles;
    // clearing it early could admit a second mutation while the first unwinds.
    expect(registry.hasActiveTurn("tailnet-turn-stale")).toBe(true);
  });
});
