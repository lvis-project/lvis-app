import { describe, expect, it } from "vitest";
import {
  ENV_BACKED_SETTINGS,
  envForcedSettingsPaths,
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

  it("pairs each settings path with exactly one variable", () => {
    const paths = ENV_BACKED_SETTINGS.map((entry) => entry.settingsPath);
    const vars = ENV_BACKED_SETTINGS.map((entry) => entry.envVar);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(vars).size).toBe(vars.length);
    // Every path is `group.key`, which is what the patch builders split on.
    for (const path of paths) expect(path).toMatch(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/);
  });
});
