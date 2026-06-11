import { describe, expect, it } from "vitest";
import {
  hasSeenFirstBootTour,
  FIRST_BOOT_SCENARIO_ID,
  type TourStateResult,
} from "../first-boot-tour-gate.js";

function okState(completedScenarios: string[]): TourStateResult {
  return {
    ok: true,
    state: {
      lastSeenScenario: completedScenarios[completedScenarios.length - 1] ?? null,
      completedScenarios,
      dismissedAt: null,
    },
  };
}

describe("hasSeenFirstBootTour", () => {
  it("returns true when the first-boot scenario is in completedScenarios", () => {
    expect(hasSeenFirstBootTour(okState([FIRST_BOOT_SCENARIO_ID]))).toBe(true);
  });

  it("returns true when first-boot is among several completed scenarios", () => {
    expect(
      hasSeenFirstBootTour(okState(["some-other-tour", FIRST_BOOT_SCENARIO_ID])),
    ).toBe(true);
  });

  it("returns false when the user completed a different tour but not first-boot", () => {
    expect(hasSeenFirstBootTour(okState(["some-other-tour"]))).toBe(false);
  });

  it("returns false on an empty completedScenarios list (fresh user)", () => {
    expect(hasSeenFirstBootTour(okState([]))).toBe(false);
  });

  it("returns false when the IPC call failed (null)", () => {
    expect(hasSeenFirstBootTour(null)).toBe(false);
  });

  it("returns false when the host returned an error result", () => {
    expect(
      hasSeenFirstBootTour({ ok: false, error: "read-failed", message: "boom" }),
    ).toBe(false);
  });
});
