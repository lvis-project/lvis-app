/**
 * OS tool sandbox boot-gate policy — decideSandboxGate + the host-classify
 * interlock predicate.
 *
 * These pure functions encode the EXPLICIT-vs-DEFAULT distinction the
 * default-on flip introduced: with `osToolSandbox` now shipping true, a host
 * that cannot activate the sandbox must DEGRADE (non-bricking) on the
 * default/settings path while the EXPLICIT `LVIS_SANDBOX_ENABLED=1` opt-in stays
 * fail-closed (abort). Boot.ts owns the side effects; this is the branch choice.
 */
import { describe, expect, it } from "vitest";
import {
  decideSandboxGate,
  shouldWarnHostClassifyInterlock,
} from "../steps/sandbox-gate.js";

describe("decideSandboxGate", () => {
  it("skips when neither the setting nor the env opt-in is on", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(
        decideSandboxGate({ settingOn: false, explicitEnv: false, platform, depsOk: true }),
      ).toEqual({ action: "skip", reason: "gate-off" });
    }
  });

  it("activates when opted in (default OR explicit) and deps are present", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      // default (settings) on
      expect(
        decideSandboxGate({ settingOn: true, explicitEnv: false, platform, depsOk: true }),
      ).toEqual({ action: "activate", reason: "deps-present" });
      // explicit env on
      expect(
        decideSandboxGate({ settingOn: false, explicitEnv: true, platform, depsOk: true }),
      ).toEqual({ action: "activate", reason: "deps-present" });
    }
  });

  it("DEGRADES (non-bricking) on the DEFAULT/settings-on path when mac/linux deps are missing", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const decision = decideSandboxGate({
        settingOn: true,
        explicitEnv: false,
        platform,
        depsOk: false,
      });
      expect(decision).toEqual({
        action: "degrade",
        reason: "degrade-default-cannot-activate",
      });
    }
  });

  it("ABORTS (fail-closed) on the EXPLICIT env opt-in when mac/linux deps are missing", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const decision = decideSandboxGate({
        settingOn: false,
        explicitEnv: true,
        platform,
        depsOk: false,
      });
      expect(decision).toEqual({
        action: "abort",
        reason: "abort-explicit-cannot-activate",
      });
    }
  });

  it("EXPLICIT wins over the default: env opt-in still aborts even when the setting is also on", () => {
    expect(
      decideSandboxGate({ settingOn: true, explicitEnv: true, platform: "linux", depsOk: false }),
    ).toEqual({ action: "abort", reason: "abort-explicit-cannot-activate" });
  });

  it("Windows deps-missing always DEGRADES (non-bricking) — even for the explicit env opt-in", () => {
    // Windows cannot abort: the one-time UAC setup is unreachable before boot
    // reaches the consent UI, so a throw would permanently brick first-run.
    expect(
      decideSandboxGate({ settingOn: true, explicitEnv: false, platform: "win32", depsOk: false }),
    ).toEqual({ action: "degrade", reason: "degrade-windows-not-installed" });
    expect(
      decideSandboxGate({ settingOn: false, explicitEnv: true, platform: "win32", depsOk: false }),
    ).toEqual({ action: "degrade", reason: "degrade-windows-not-installed" });
  });
});

describe("shouldWarnHostClassifyInterlock", () => {
  it("fires only when hostClassifiesRisk is ON and the sandbox is NOT active", () => {
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: true, sandboxActive: false }),
    ).toBe(true);
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: true, sandboxActive: true }),
    ).toBe(false);
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: false, sandboxActive: false }),
    ).toBe(false);
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: false, sandboxActive: true }),
    ).toBe(false);
  });

  it("fires in the DEGRADED state (gate ON by default + sandbox could not activate)", () => {
    // The degraded path leaves the sandbox inactive while the gate is on. Derive
    // sandboxActive the way boot does (only "activate"-then-success sets it true)
    // and confirm the interlock still warns — the regression the default-on flip
    // would introduce if the old `!optIn` proxy were kept.
    const decision = decideSandboxGate({
      settingOn: true,
      explicitEnv: false,
      platform: "linux",
      depsOk: false,
    });
    expect(decision.action).toBe("degrade");
    const sandboxActive = decision.action === "activate"; // false on degrade
    expect(
      shouldWarnHostClassifyInterlock({ hostClassifiesRisk: true, sandboxActive }),
    ).toBe(true);
  });
});
