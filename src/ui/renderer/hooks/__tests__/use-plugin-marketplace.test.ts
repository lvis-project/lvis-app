import { describe, expect, it } from "vitest";
import { assertInstalledPluginVersion } from "../use-plugin-marketplace.js";
import { pluginCardSummary as card } from "../../tabs/__tests__/test-helpers.js";

describe("assertInstalledPluginVersion", () => {
  it("accepts matching installed manifest versions", () => {
    expect(() =>
      assertInstalledPluginVersion([card({ id: "meeting", version: "0.5.24" })], {
        requestedPluginId: "meeting",
        installedPluginId: "meeting",
        expectedVersion: "0.5.24",
      }),
    ).not.toThrow();
  });

  it("throws when an update reinstall leaves the old manifest version loaded", () => {
    expect(() =>
      assertInstalledPluginVersion([card({ id: "meeting", version: "0.5.23" })], {
        requestedPluginId: "meeting",
        installedPluginId: "meeting",
        expectedVersion: "0.5.24",
      }),
    ).toThrow(/expected 0\.5\.24, got 0\.5\.23/);
  });
});