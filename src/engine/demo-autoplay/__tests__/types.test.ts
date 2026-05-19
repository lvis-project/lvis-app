/**
 * Demo activation predicate — proposal §7 truth table.
 *
 * Updated for the returning-user gate (PR following #1019): autoplay no
 * longer fires on first run. The ScenarioShowcase chain owns first-boot;
 * autoplay re-engages once `onboardingCompleted === true`.
 */
import { describe, it, expect } from "vitest";
import { shouldActivateDemoAutoplay } from "../types.js";

describe("shouldActivateDemoAutoplay", () => {
  it("skips on first run (flag undefined, onboarding incomplete) so showcase chain owns first-boot", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: undefined,
        onboardingCompleted: undefined,
        demoVendorPresent: true,
      }),
    ).toBe(false);
  });

  it("skips when onboardingCompleted is explicitly false (mid-onboarding boot)", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: undefined,
        onboardingCompleted: false,
        demoVendorPresent: true,
      }),
    ).toBe(false);
  });

  it("activates for returning users (onboardingCompleted=true) when vendor env is present", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: undefined,
        onboardingCompleted: true,
        demoVendorPresent: true,
      }),
    ).toBe(true);
  });

  it("activates when flag is explicitly true (developer/QA opt-in), regardless of onboarding state", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: true,
        onboardingCompleted: true,
        demoVendorPresent: true,
      }),
    ).toBe(true);
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: true,
        onboardingCompleted: false,
        demoVendorPresent: true,
      }),
    ).toBe(true);
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: true,
        onboardingCompleted: undefined,
        demoVendorPresent: true,
      }),
    ).toBe(true);
  });

  it("skips when user explicitly opted out (flag=false), even for returning users", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: false,
        onboardingCompleted: undefined,
        demoVendorPresent: true,
      }),
    ).toBe(false);
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: false,
        onboardingCompleted: true,
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
