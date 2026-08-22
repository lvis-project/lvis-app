import { describe, expect, it } from "vitest";
import {
  ENV_BACKED_SETTINGS,
  envForcedSettingsPaths,
  envForcedValueForSettingsPath,
  envVarForSettingsPath,
  parseEnvForcedSettingsPaths,
  resolveEnvBackedNumber,
} from "../env-backed-settings.js";

describe("env-backed settings registry", () => {
  it("reports only the variables set to the exact ON value", () => {
    expect(envForcedSettingsPaths({
      LVIS_LOCAL_API: "1",
      // Not the ON value: the resolvers leave these in the user's hands, so a
      // surface that called them forced would be describing the wrong state.
      LVIS_A2A: "0",
      LVIS_A2A_REMOTE: "true",
      LVIS_A2A_REMOTE_RECEIVER: "",
    })).toEqual(["system.localApiServer"]);

    expect(envForcedSettingsPaths({})).toEqual([]);
  });

  it("names the variable a surface should show for a forced setting", () => {
    expect(envVarForSettingsPath("features.a2aRemoteReceiver")).toBe("LVIS_A2A_REMOTE_RECEIVER");
    expect(envVarForSettingsPath("features.notARealGate")).toBeNull();
  });

  it("drops a path this build does not know rather than rendering it", () => {
    expect(parseEnvForcedSettingsPaths(["system.localApiServer", "system.somethingElse", 7]))
      .toEqual(["system.localApiServer"]);
    expect(parseEnvForcedSettingsPaths("system.localApiServer")).toBeNull();
    expect(parseEnvForcedSettingsPaths(null)).toBeNull();
  });

  it("reports the update check forced only when the variable turns it OFF", () => {
    // The host rule is `(setting ?? true) && env`, so an ON value cannot
    // override a setting that says off — reporting it as forced would tell the
    // user the switch is dead when it still works.
    for (const on of ["1", "true", "yes", ""]) {
      expect(envForcedValueForSettingsPath("marketplace.updateCheckEnabled", {
        LVIS_MARKETPLACE_UPDATE_CHECK: on,
      })).toBeUndefined();
    }
    for (const off of ["0", "false", "FALSE"]) {
      expect(envForcedValueForSettingsPath("marketplace.updateCheckEnabled", {
        LVIS_MARKETPLACE_UPDATE_CHECK: off,
      })).toBe(false);
    }
    expect(envForcedValueForSettingsPath("marketplace.updateCheckEnabled", {})).toBeUndefined();
  });

  it("reports the offline copy forced in both directions once the variable is set", () => {
    expect(envForcedValueForSettingsPath("marketplace.offlineCacheEnabled", {
      LVIS_MARKETPLACE_USE_CACHE: "1",
    })).toBe(true);
    expect(envForcedValueForSettingsPath("marketplace.offlineCacheEnabled", {
      LVIS_MARKETPLACE_USE_CACHE: "no",
    })).toBe(false);
    // Unset is the only value that leaves the decision to the setting.
    expect(envForcedValueForSettingsPath("marketplace.offlineCacheEnabled", {})).toBeUndefined();
    expect(envForcedSettingsPaths({ LVIS_MARKETPLACE_USE_CACHE: "off" }))
      .toEqual(["marketplace.offlineCacheEnabled"]);
  });

  it("reports the corporate CA switch forced only by the variable that skips it", () => {
    // The variable's NAME is the negative: LVIS_SKIP_CORP_CA=1 means "do not
    // do this", so it forces the setting OFF. Reading it as an ON gate would
    // invert what the notice tells the user.
    expect(envForcedValueForSettingsPath("system.corpCaEnabled", { LVIS_SKIP_CORP_CA: "1" }))
      .toBe(false);
    expect(envForcedValueForSettingsPath("system.corpCaEnabled", { LVIS_SKIP_CORP_CA: "0" }))
      .toBeUndefined();
    expect(envForcedValueForSettingsPath("system.corpCaEnabled", {})).toBeUndefined();
  });

  it("carries the certificate name itself, not a boolean", () => {
    // The only text entry in the registry. The value IS the forced setting,
    // so the resolver reads the name from here rather than re-reading the
    // variable and disagreeing about when it applies.
    expect(envForcedValueForSettingsPath("system.corpCaCommonName", {
      LVIS_CORP_CA_CN: "  Acme Root CA  ",
    })).toBe("Acme Root CA");
    // Set to nothing is not a name to search for.
    expect(envForcedValueForSettingsPath("system.corpCaCommonName", { LVIS_CORP_CA_CN: "   " }))
      .toBeUndefined();
    expect(envForcedSettingsPaths({ LVIS_CORP_CA_CN: "Acme Root CA", LVIS_CORP_CA_DEBUG: "1" }))
      .toEqual(["system.corpCaDebugLog", "system.corpCaCommonName"]);
  });

  it("carries the cleanup window as a number, parsed by the setting's own rule", () => {
    // The only numeric entry. It answers with the value the timer will be armed
    // with, not with "the variable is set" — a value the setting itself would
    // reject is not a forced value either.
    expect(envForcedValueForSettingsPath("system.shutdownCleanupTimeoutMs", {
      LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "45000",
    })).toBe(45_000);
    expect(envForcedValueForSettingsPath("system.shutdownCleanupTimeoutMs", {
      LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "0",
    })).toBeUndefined();
    expect(envForcedSettingsPaths({ LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "abc" })).toEqual([]);
    expect(envForcedSettingsPaths({ LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "45000" }))
      .toEqual(["system.shutdownCleanupTimeoutMs"]);
  });

  it("resolves a numeric setting environment-first, then saved, then default", () => {
    expect(resolveEnvBackedNumber(
      "system.shutdownCleanupTimeoutMs", 30_000,
      { LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "45000" }, 15_000,
    )).toBe(45_000);
    expect(resolveEnvBackedNumber("system.shutdownCleanupTimeoutMs", 30_000, {}, 15_000))
      .toBe(30_000);
    expect(resolveEnvBackedNumber("system.shutdownCleanupTimeoutMs", undefined, {}, 15_000))
      .toBe(15_000);
    // A boolean gate asked for a number is a wiring mistake, not a forced
    // value: the setting still decides rather than the timer being armed with
    // something that was never a duration.
    expect(resolveEnvBackedNumber(
      "system.localApiServer", 30_000, { LVIS_LOCAL_API: "1" }, 15_000,
    )).toBe(30_000);
  });

  it("returns undefined for a path that is not in the registry", () => {
    expect(envForcedValueForSettingsPath("system.notARealGate", { LVIS_LOCAL_API: "1" }))
      .toBeUndefined();
  });

  it("pairs each settings path with exactly one variable", () => {
    const paths = ENV_BACKED_SETTINGS.map((entry) => entry.settingsPath);
    const vars = ENV_BACKED_SETTINGS.map((entry) => entry.envVar);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(vars).size).toBe(vars.length);
    // Every path is `group.key`, which is what the patch builders split on.
    for (const path of paths) expect(path).toMatch(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/);
  });
});
