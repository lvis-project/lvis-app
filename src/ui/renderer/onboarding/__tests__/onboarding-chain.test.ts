/**
 * Z onboarding chain — reducer unit test.
 *
 * Verifies every legal transition + that out-of-order events stay
 * no-op. Pure test, no React mount, no jsdom.
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

  it("full happy-path traversal", () => {
    const result = transitionStage("idle", [
      { type: "probe-start" },
      { type: "showcase-start" },
      { type: "login-success" },
      { type: "welcome-accept" },
      { type: "memory-finish" },
      { type: "tour-finish" },
      { type: "plugins-close" },
    ]);
    expect(result).toBe("done");
  });

  it("showcase-skip jumps directly to done", () => {
    const result = transitionStage("idle", [
      { type: "probe-start" },
      { type: "showcase-skip" },
    ]);
    expect(result).toBe("done");
  });

  it("login-skip still advances to welcome", () => {
    const result = transitionStage("idle", [
      { type: "probe-start" },
      { type: "showcase-start" },
      { type: "login-skip" },
    ]);
    expect(result).toBe("welcome");
  });

  it("welcome-skip jumps to done (bypasses memory + tour + plugins)", () => {
    const result = transitionStage("idle", [
      { type: "probe-start" },
      { type: "showcase-start" },
      { type: "login-success" },
      { type: "welcome-skip" },
    ]);
    expect(result).toBe("done");
  });

  it("tour-skip still advances to plugins", () => {
    const result = transitionStage("idle", [
      { type: "probe-start" },
      { type: "showcase-start" },
      { type: "login-success" },
      { type: "welcome-accept" },
      { type: "memory-finish" },
      { type: "tour-skip" },
    ]);
    expect(result).toBe("plugins");
  });

  it("out-of-order events stay no-op", () => {
    expect(
      nextOnboardingStage("showcase", { type: "welcome-accept" }),
    ).toBe("showcase");
    expect(nextOnboardingStage("idle", { type: "login-success" })).toBe(
      "idle",
    );
    expect(
      nextOnboardingStage("welcome", { type: "memory-finish" }),
    ).toBe("welcome");
    expect(nextOnboardingStage("tour", { type: "plugins-close" })).toBe(
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

  it("force-finish collapses chain from any stage", () => {
    const stages: OnboardingChainStage[] = [
      "showcase",
      "login",
      "welcome",
      "memory",
      "tour",
      "plugins",
    ];
    for (const stage of stages) {
      expect(nextOnboardingStage(stage, { type: "force-finish" })).toBe(
        "done",
      );
    }
  });

  it("showcase → happy path traversal terminates at done", () => {
    const result = transitionStage("showcase", [
      { type: "showcase-start" },
      { type: "login-success" },
      { type: "welcome-accept" },
      { type: "memory-finish" },
      { type: "tour-finish" },
      { type: "plugins-close" },
    ]);
    expect(result).toBe("done");
  });
});

describe("onboardingChainReducer (state record)", () => {
  it("initial state is idle with no selected scenario", () => {
    expect(initialOnboardingChainState).toEqual({
      stage: "idle",
      selectedScenarioId: null,
    });
  });

  it("showcase-start carries the picked scenarioId into chain context", () => {
    const next = onboardingChainReducer(
      { stage: "showcase", selectedScenarioId: null },
      { type: "showcase-start", scenarioId: "docs" },
    );
    expect(next).toEqual({ stage: "login", selectedScenarioId: "docs" });
  });

  it("showcase-start without scenarioId preserves null selection", () => {
    const next = onboardingChainReducer(
      { stage: "showcase", selectedScenarioId: null },
      { type: "showcase-start" },
    );
    expect(next).toEqual({ stage: "login", selectedScenarioId: null });
  });

  it("downstream transitions preserve the selected scenarioId", () => {
    const result = transitionState(initialOnboardingChainState, [
      { type: "probe-start" },
      { type: "showcase-start", scenarioId: "meeting" },
      { type: "login-success" },
      { type: "welcome-accept" },
      { type: "memory-finish" },
      { type: "tour-finish" },
      { type: "plugins-close" },
    ]);
    expect(result).toEqual({
      stage: "done",
      selectedScenarioId: "meeting",
    });
  });

  it("force-finish collapses to done and keeps the prior selection", () => {
    const next = onboardingChainReducer(
      { stage: "tour", selectedScenarioId: "multi-agent" },
      { type: "force-finish" },
    );
    expect(next).toEqual({
      stage: "done",
      selectedScenarioId: "multi-agent",
    });
  });
});
