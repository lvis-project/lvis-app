import { describe, expect, it } from "vitest";
import {
  ENV_BACKED_SETTINGS,
  envForcedSettingsPaths,
  envForcedValueForSettingsPath,
  envVarForSettingsPath,
  parseEnvForcedSettingsPaths,
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
