/**
 * Binds the renderer's Doctor-repair target resolution to the shared catalog
 * lookup key. The result of `findPluginDoctorMarketplaceItem` is handed
 * straight to `installMarketplacePlugin`, so a normalization change decides
 * which package a repair actually installs.
 *
 * These assertions red when `shared/plugin-lookup-key.ts` loses a
 * normalization step — which is what makes the renderer side of the
 * consolidation covered rather than merely consistent-by-import.
 */
import { describe, it, expect } from "vitest";
import {
  findPluginDoctorMarketplaceItem,
  getPluginDoctorInstallKey,
} from "../plugin-doctor-match.js";
import type { MarketplaceItem, PluginCardSummary } from "../../types.js";

function card(over: Partial<PluginCardSummary> & { id: string }): PluginCardSummary {
  return {
    name: over.id,
    description: "",
    sampleTools: [],
    capabilities: [],
    tools: [],
    ...over,
  };
}

function item(over: Partial<MarketplaceItem> & { id: string }): MarketplaceItem {
  return {
    name: over.id,
    description: "",
    packageSpec: over.id,
    installed: false,
    enabled: false,
    ...over,
  };
}

describe("getPluginDoctorInstallKey", () => {
  it("prefers the first install alias over the plugin id", () => {
    expect(getPluginDoctorInstallKey(card({ id: "weather", installAliases: ["@lvis/weather"] })))
      .toBe("@lvis/weather");
  });

  it("falls back to the plugin id when there is no alias", () => {
    expect(getPluginDoctorInstallKey(card({ id: "weather" }))).toBe("weather");
    expect(getPluginDoctorInstallKey(card({ id: "weather", installAliases: [] }))).toBe("weather");
  });
});

describe("findPluginDoctorMarketplaceItem", () => {
  it("matches an exact id literally", () => {
    const catalog = [item({ id: "other" }), item({ id: "weather" })];
    expect(findPluginDoctorMarketplaceItem(card({ id: "weather" }), catalog)?.id).toBe("weather");
  });

  it("matches through the shared lookup key when the spellings differ", () => {
    const catalog = [item({ id: "lvis-plugin-weather", name: "Weather", packageSpec: "@lvis/lvis-plugin-weather@1.0.0" })];
    expect(findPluginDoctorMarketplaceItem(card({ id: "weather" }), catalog)?.id)
      .toBe("lvis-plugin-weather");
  });

  it("matches on the package spec when id and name do not line up", () => {
    const catalog = [item({ id: "wx-1", name: "Wx", packageSpec: "@lvis/plugin-weather@2.0.0" })];
    expect(findPluginDoctorMarketplaceItem(card({ id: "weather" }), catalog)?.id).toBe("wx-1");
  });

  it("matches an install alias", () => {
    const catalog = [item({ id: "lvis-plugin-weather" })];
    const plugin = card({ id: "com.acme.weather", name: "Acme", installAliases: ["weather"] });
    expect(findPluginDoctorMarketplaceItem(plugin, catalog)?.id).toBe("lvis-plugin-weather");
  });

  it("skips catalog entries that are not plugins", () => {
    const catalog = [item({ id: "weather", pluginType: "skill" }), item({ id: "weather-b", name: "weather" })];
    expect(findPluginDoctorMarketplaceItem(card({ id: "weather" }), catalog)?.id).toBe("weather-b");
  });

  it("returns null when no catalog entry corresponds", () => {
    const catalog = [item({ id: "weather-pro" }), item({ id: "github" })];
    expect(findPluginDoctorMarketplaceItem(card({ id: "weather" }), catalog)).toBeNull();
  });

  it("does not match a different plugin that merely shares a prefix", () => {
    const catalog = [item({ id: "git" })];
    expect(findPluginDoctorMarketplaceItem(card({ id: "github" }), catalog)).toBeNull();
  });
});
