/**
 * Demo activation predicate — proposal §7 truth table.
 */
import { describe, it, expect } from "vitest";
import { shouldActivateDemoAutoplay } from "../types.js";

describe("shouldActivateDemoAutoplay", () => {
  it("activates on first run when LVIS_DEMO_VENDOR is set", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: undefined,
        onboardingCompleted: undefined,
        demoVendorPresent: true,
      }),
    ).toBe(true);
  });

  it("activates when flag is explicitly true", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: true,
        onboardingCompleted: true,
        demoVendorPresent: true,
      }),
    ).toBe(true);
  });

  it("skips when onboarding already completed and flag is undefined", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: undefined,
        onboardingCompleted: true,
        demoVendorPresent: true,
      }),
    ).toBe(false);
  });

  it("skips when user explicitly opted out (flag=false)", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: false,
        onboardingCompleted: undefined,
        demoVendorPresent: true,
      }),
    ).toBe(false);
  });

  it("skips in packaged production (no LVIS_DEMO_VENDOR)", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: true,
        onboardingCompleted: undefined,
        demoVendorPresent: false,
      }),
    ).toBe(false);
  });
});
