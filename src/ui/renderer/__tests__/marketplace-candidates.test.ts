import { describe, expect, it } from "vitest";
import {
  LOCAL_MARKETPLACE_CANDIDATES,
  mergeMarketplaceCandidates,
} from "../marketplace-candidates.js";
import type { MarketplaceItem } from "../types.js";

describe("local marketplace candidates", () => {
  it("projects non-default providers into provider marketplace candidates", () => {
    const providerSpecs = LOCAL_MARKETPLACE_CANDIDATES
      .filter((item) => item.pluginType === "provider")
      .map((item) => item.packageSpec);

    expect(providerSpecs).toContain("provider:groq");
    expect(providerSpecs).toContain("provider:ollama");
    expect(providerSpecs).not.toContain("provider:openai");
    expect(providerSpecs).not.toContain("provider:openrouter");
  });

  it("projects non-default themes and locales into marketplace candidates", () => {
    const specs = LOCAL_MARKETPLACE_CANDIDATES.map((item) => item.packageSpec);

    expect(specs).toContain("theme:tokyo-night");
    expect(specs).toContain("theme:high-contrast");
    expect(specs).not.toContain("theme:moonstone");
    expect(specs).not.toContain("theme:gallery");
    expect(specs).toContain("language-pack:ko");
    expect(specs).not.toContain("language-pack:en");
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

    expect(merged).toContain(remoteGroq);
    expect(merged.filter((item) => item.packageSpec === "provider:groq")).toHaveLength(1);
    expect(merged.find((item) => item.packageSpec === "provider:groq")?.name).toBe("Remote Groq Provider");
  });
});
