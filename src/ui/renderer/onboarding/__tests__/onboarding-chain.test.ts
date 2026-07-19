/**
 * Z onboarding chain — reducer unit test.
 *
 * Verifies every legal transition + that out-of-order events stay
 * no-op. 2026-05-20 redesign — the `welcome` stage was removed; the
 * new chain order is:
 *   showcase → memory → personalized_welcome → tour → done
 * Memory now precedes the welcome card so the welcome can reference
 * the 호칭/자기소개 the user just typed.
 *
 * Pure test, no React mount, no jsdom.
 */
import { describe, it, expect } from "vitest";
import {
  initialOnboardingChainState,
  nextOnboardingStage,
  onboardingChainReducer,
  type OnboardingChainEvent,
  type OnboardingChainStage,
  type OnboardingChainState,
} from "../onboarding-chain.js";

function transitionStage(
  start: OnboardingChainStage,
  events: OnboardingChainEvent[],
): OnboardingChainStage {
  return events.reduce<OnboardingChainStage>(
    (stage, event) => nextOnboardingStage(stage, event),
    start,
  );
}

function transitionState(
  start: OnboardingChainState,
  events: OnboardingChainEvent[],
): OnboardingChainState {
  return events.reduce<OnboardingChainState>(
    (state, event) => onboardingChainReducer(state, event),
    start,
  );
}

describe("nextOnboardingStage", () => {
  it("idle → showcase via probe-start", () => {
    expect(nextOnboardingStage("idle", { type: "probe-start" })).toBe(
      "showcase",
    );
  });

  it("idle → done via probe-skip", () => {
    expect(nextOnboardingStage("idle", { type: "probe-skip" })).toBe("done");
  });

  it("showcase ignores stray probe-skip (#1014 race guard)", () => {
    expect(nextOnboardingStage("showcase", { type: "probe-skip" })).toBe(
      "showcase",
    );
  });

  it("full happy-path traversal — memory precedes personalized_welcome", () => {
    const result = transitionStage("idle", [
      { type: "probe-start" },
      { type: "showcase-start" },
      { type: "memory-finish" },
      { type: "personalized-welcome-accept" },
      { type: "tour-finish" },
    ]);
    expect(result).toBe("done");
  });

  it("tour-skip completes onboarding without an extra plugin popup", () => {
    const result = transitionStage("idle", [
      { type: "probe-start" },
      { type: "showcase-start" },
      { type: "memory-finish" },
      { type: "personalized-welcome-accept" },
      { type: "tour-skip" },
    ]);
    expect(result).toBe("done");
  });

  it("out-of-order events stay no-op", () => {
    expect(
      nextOnboardingStage("showcase", { type: "personalized-welcome-accept" }),
    ).toBe("showcase");
    expect(nextOnboardingStage("idle", { type: "memory-finish" })).toBe(
      "idle",
    );
    expect(
      nextOnboardingStage("memory", { type: "personalized-welcome-accept" }),
    ).toBe("memory");
    expect(nextOnboardingStage("tour", { type: "memory-finish" })).toBe(
      "tour",
    );
  });

  it("done is terminal — events stay no-op", () => {
    expect(nextOnboardingStage("done", { type: "probe-start" })).toBe(
      "done",
    );
    expect(nextOnboardingStage("done", { type: "showcase-start" })).toBe(
      "done",
    );
  });

  it("showcase → happy path traversal terminates at done", () => {
    const result = transitionStage("showcase", [
      { type: "showcase-start" },
      { type: "memory-finish" },
      { type: "personalized-welcome-accept" },
      { type: "tour-finish" },
    ]);
    expect(result).toBe("done");
  });

  it("personalized_welcome only advances via personalized-welcome-accept", () => {
    expect(
      nextOnboardingStage("personalized_welcome", { type: "tour-finish" }),
    ).toBe("personalized_welcome");
    expect(
      nextOnboardingStage("personalized_welcome", {
        type: "personalized-welcome-accept",
      }),
    ).toBe("tour");
  });
});

describe("onboardingChainReducer (state record)", () => {
  it("initial state is idle with no selected scenario / empty memory seed", () => {
    expect(initialOnboardingChainState).toEqual({
      stage: "idle",
      selectedScenarioId: null,
      memorySeed: { nickname: "", introduction: "" },
    });
  });

  it("showcase-start carries the picked scenarioId into chain context", () => {
    const next = onboardingChainReducer(
      {
        stage: "showcase",
        selectedScenarioId: null,
        memorySeed: { nickname: "", introduction: "" },
      },
      { type: "showcase-start", scenarioId: "docs" },
    );
    expect(next).toEqual({
      stage: "memory",
      selectedScenarioId: "docs",
      memorySeed: { nickname: "", introduction: "" },
    });
  });

  it("showcase-start without scenarioId preserves null selection", () => {
    const next = onboardingChainReducer(
      {
        stage: "showcase",
        selectedScenarioId: null,
        memorySeed: { nickname: "", introduction: "" },
      },
      { type: "showcase-start" },
    );
    expect(next).toEqual({
      stage: "memory",
      selectedScenarioId: null,
      memorySeed: { nickname: "", introduction: "" },
    });
  });

  it("memory-finish stores nickname + introduction into chain context", () => {
    const next = onboardingChainReducer(
      {
        stage: "memory",
        selectedScenarioId: "meeting",
        memorySeed: { nickname: "", introduction: "" },
      },
      { type: "memory-finish", nickname: "Ken", introduction: "PM" },
    );
    expect(next).toEqual({
      stage: "personalized_welcome",
      selectedScenarioId: "meeting",
      memorySeed: { nickname: "Ken", introduction: "PM" },
    });
  });

  it("memory-finish without payload preserves prior memorySeed values", () => {
    const next = onboardingChainReducer(
      {
        stage: "memory",
        selectedScenarioId: null,
        memorySeed: { nickname: "Ken", introduction: "PM" },
      },
      { type: "memory-finish" },
    );
    expect(next).toEqual({
      stage: "personalized_welcome",
      selectedScenarioId: null,
      memorySeed: { nickname: "Ken", introduction: "PM" },
    });
  });

  it("downstream transitions preserve the selected scenarioId + memory seed", () => {
    const result = transitionState(initialOnboardingChainState, [
      { type: "probe-start" },
      { type: "showcase-start", scenarioId: "meeting" },
      { type: "memory-finish", nickname: "Ken", introduction: "PM" },
      { type: "personalized-welcome-accept" },
      { type: "tour-finish" },
    ]);
    expect(result).toEqual({
      stage: "done",
      selectedScenarioId: "meeting",
      memorySeed: { nickname: "Ken", introduction: "PM" },
      // Finishing the tour records the "chain" reason
      // so the post-tour first-task proposal is allowed to fire.
      completionReason: "chain",
    });
  });
});

describe("onboardingChainReducer — completionReason (post-tour-first-task gate)", () => {
  it("probe-skip → done records completionReason 'probe-skip' (tour never shown)", () => {
    const next = onboardingChainReducer(initialOnboardingChainState, {
      type: "probe-skip",
    });
    expect(next.stage).toBe("done");
    // A returning user reached `done` without the tour — the
    // post-tour first-task proposal must NOT fire for this reason.
    expect(next.completionReason).toBe("probe-skip");
  });

  it("tour-finish → done records completionReason 'chain' without opening the plugin showcase", () => {
    const atTour: OnboardingChainState = {
      stage: "tour",
      selectedScenarioId: null,
      memorySeed: { nickname: "", introduction: "" },
    };
    const next = onboardingChainReducer(atTour, { type: "tour-finish" });
    expect(next.stage).toBe("done");
    expect(next.completionReason).toBe("chain");
  });

  it("in-progress stages carry no completionReason", () => {
    const afterShowcase = onboardingChainReducer(
      { ...initialOnboardingChainState, stage: "showcase" },
      { type: "showcase-start", scenarioId: "docs" },
    );
    expect(afterShowcase.stage).toBe("memory");
    expect(afterShowcase.completionReason).toBeUndefined();
  });

  it("a late probe-skip while already in done does NOT overwrite 'chain'", () => {
    // Regression: completionReason must only be recorded on the transition
    // INTO done. A stale/duplicate probe-skip arriving after a full-funnel
    // completion must not flip "chain" → "probe-skip" (which would hide the
    // post-tour UI for a user who actually finished the tour).
    const doneViaChain = onboardingChainReducer(
      {
        stage: "tour",
        selectedScenarioId: null,
        memorySeed: { nickname: "", introduction: "" },
      },
      { type: "tour-finish" },
    );
    expect(doneViaChain.completionReason).toBe("chain");
    const afterLateProbe = onboardingChainReducer(doneViaChain, {
      type: "probe-skip",
    });
    expect(afterLateProbe.stage).toBe("done");
    expect(afterLateProbe.completionReason).toBe("chain");
  });
});
