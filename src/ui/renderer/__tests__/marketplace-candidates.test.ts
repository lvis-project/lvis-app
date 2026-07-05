import { describe, expect, it } from "vitest";
import {
  LOCAL_MARKETPLACE_CANDIDATES,
  mergeMarketplaceCandidates,
} from "../marketplace-candidates.js";
import { LOCAL_MARKETPLACE_ASSET_ENTRIES } from "../marketplace-asset-registry.js";
import type { MarketplaceItem } from "../types.js";

describe("local marketplace candidates", () => {
  it("projects the marketplace asset registry into local catalog candidates", () => {
    expect(LOCAL_MARKETPLACE_CANDIDATES.map((item) => item.packageSpec))
      .toEqual(LOCAL_MARKETPLACE_ASSET_ENTRIES.map((entry) => entry.packageSpec));
    for (const entry of LOCAL_MARKETPLACE_ASSET_ENTRIES) {
      expect(LOCAL_MARKETPLACE_CANDIDATES.find((item) => item.packageSpec === entry.packageSpec))
        .toMatchObject({
          id: entry.id,
          pluginType: entry.packageType,
          packageAsset: entry.asset,
          installed: false,
          enabled: false,
        });
    }
  });

  it("projects non-default providers into provider marketplace candidates", () => {
    const providers = LOCAL_MARKETPLACE_CANDIDATES
      .filter((item) => item.pluginType === "provider");
    const providerSpecs = providers.map((item) => item.packageSpec);

    expect(providerSpecs).toContain("provider:groq");
    expect(providerSpecs).toContain("provider:ollama");
    expect(providerSpecs).not.toContain("provider:openai");
    expect(providerSpecs).not.toContain("provider:openrouter");
    expect(providers.find((item) => item.packageSpec === "provider:groq")?.packageAsset)
      .toEqual({ type: "provider", providerId: "groq" });
  });

  it("projects non-default themes and locales into marketplace candidates", () => {
    const specs = LOCAL_MARKETPLACE_CANDIDATES.map((item) => item.packageSpec);

    expect(specs).toContain("theme:tokyo-night");
    expect(specs).toContain("theme:high-contrast");
    expect(specs).not.toContain("theme:moonstone");
    expect(specs).not.toContain("theme:gallery");
    expect(specs).toContain("language-pack:ko");
    expect(specs).not.toContain("language-pack:en");
    expect(LOCAL_MARKETPLACE_CANDIDATES.find((item) => item.packageSpec === "theme:tokyo-night")?.packageAsset)
      .toEqual({ type: "theme", bundleId: "tokyo-night" });
    expect(LOCAL_MARKETPLACE_CANDIDATES.find((item) => item.packageSpec === "language-pack:ko")?.packageAsset)
      .toEqual({ type: "language-pack", locale: "ko" });
  });

  it("lets remote catalog rows override local candidates by package spec", () => {
    const remoteGroq: MarketplaceItem = {
      id: "remote-groq",
      name: "Remote Groq Provider",
      description: "Server catalog row",
      packageSpec: "provider:groq",
      installed: false,
      enabled: false,
      pluginType: "provider",
    };

    const merged = mergeMarketplaceCandidates([remoteGroq]);

    expect(merged.filter((item) => item.packageSpec === "provider:groq")).toHaveLength(1);
    expect(merged.find((item) => item.packageSpec === "provider:groq"))
      .toMatchObject({
        id: "remote-groq",
        name: "Remote Groq Provider",
        packageAsset: { type: "provider", providerId: "groq" },
      });
  });
});
