import { describe, expect, it } from "vitest";
import { assertInstalledPluginVersion } from "../use-plugin-marketplace.js";
import type { PluginCardSummary } from "../../types.js";

function card(input: Partial<PluginCardSummary> & Pick<PluginCardSummary, "id" | "version">): PluginCardSummary {
  return {
    name: input.id,
    description: "",
    sampleTools: [],
    capabilities: [],
    tools: [],
    ...input,
  };
}

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