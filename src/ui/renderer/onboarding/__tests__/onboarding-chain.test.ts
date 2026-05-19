/**
 * Z onboarding chain — reducer unit test.
 *
 * Verifies every legal transition + that out-of-order events stay no-op.
 * Pure test, no React mount, no jsdom.
 */
import { describe, it, expect } from "vitest";
import {
  onboardingChainReducer,
  type OnboardingChainStage,
} from "../onboarding-chain.js";

function transition(
  start: OnboardingChainStage,
  events: Parameters<typeof onboardingChainReducer>[1][],
): OnboardingChainStage {
  return events.reduce(
    (state, event) => onboardingChainReducer(state, event),
    start,
  );
}

describe("onboardingChainReducer", () => {
  it("idle → showcase via probe-start", () => {
    expect(onboardingChainReducer("idle", { type: "probe-start" })).toBe(
      "showcase",
    );
  });

  it("idle → done via probe-skip", () => {
    expect(onboardingChainReducer("idle", { type: "probe-skip" })).toBe(
      "done",
    );
  });

  it("showcase ignores stray probe-skip (#1014 race guard)", () => {
    // Boot reducer initial state reverted to `idle`. The async boot
    // probe dispatches exactly one of probe-start / probe-skip from
    // `idle`, so a stale probe-skip arriving after showcase has been
    // mounted must NOT collapse the Dialog — that produced the
    // closet-flash bug for genuinely fresh-state users.
    expect(
      onboardingChainReducer("showcase", { type: "probe-skip" }),
    ).toBe("showcase");
  });

  it("full happy-path traversal", () => {
    const result = transition("idle", [
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
    const result = transition("idle", [
      { type: "probe-start" },
      { type: "showcase-skip" },
    ]);
    expect(result).toBe("done");
  });

  it("login-skip still advances to welcome", () => {
    const result = transition("idle", [
      { type: "probe-start" },
      { type: "showcase-start" },
      { type: "login-skip" },
    ]);
    expect(result).toBe("welcome");
  });

  it("welcome-skip jumps to done (bypasses memory + tour + plugins)", () => {
    const result = transition("idle", [
      { type: "probe-start" },
      { type: "showcase-start" },
      { type: "login-success" },
      { type: "welcome-skip" },
    ]);
    expect(result).toBe("done");
  });

  it("tour-skip still advances to plugins", () => {
    const result = transition("idle", [
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
    // Cannot welcome-accept from showcase
    expect(
      onboardingChainReducer("showcase", { type: "welcome-accept" }),
    ).toBe("showcase");
    // Cannot login-success from idle
    expect(onboardingChainReducer("idle", { type: "login-success" })).toBe(
      "idle",
    );
    // Cannot memory-finish from welcome
    expect(
      onboardingChainReducer("welcome", { type: "memory-finish" }),
    ).toBe("welcome");
    // Cannot plugins-close from tour
    expect(onboardingChainReducer("tour", { type: "plugins-close" })).toBe(
      "tour",
    );
  });

  it("done is terminal — events stay no-op", () => {
    expect(onboardingChainReducer("done", { type: "probe-start" })).toBe(
      "done",
    );
    expect(onboardingChainReducer("done", { type: "showcase-start" })).toBe(
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
      expect(
        onboardingChainReducer(stage, { type: "force-finish" }),
      ).toBe("done");
    }
  });

  it("showcase → happy path traversal terminates at done", () => {
    // Verify forward traversal starting from showcase (after the boot
    // probe dispatched probe-start) still ends at `done` so the chain
    // reaches `markOnboardingCompleted` and the persistence side-effect
    // fires.
    const result = transition("showcase", [
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
