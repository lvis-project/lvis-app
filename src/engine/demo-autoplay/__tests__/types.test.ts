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

  it("activates when flag is explicitly true AND onboarding has completed (developer/QA opt-in, post-onboard)", () => {
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: true,
        onboardingCompleted: true,
        demoVendorPresent: true,
      }),
    ).toBe(true);
  });

  it("M2 — defers explicit flag=true to showcase chain when onboardingCompleted is not yet true", () => {
    // critic MAJOR (2026-05-19): a fresh-state user carrying flag=true
    // (e.g. profile snapshot, QA fixture) would otherwise paint demo over
    // the Z chain reducer mid-stage and the chain would never advance to
    // `markOnboardingCompleted`, looping the user back into the demo every
    // boot. Both fresh-state branches must defer to the showcase chain.
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: true,
        onboardingCompleted: false,
        demoVendorPresent: true,
      }),
    ).toBe(false);
    expect(
      shouldActivateDemoAutoplay({
        flagEnabled: true,
        onboardingCompleted: undefined,
        demoVendorPresent: true,
      }),
    ).toBe(false);
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
