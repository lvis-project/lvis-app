import { describe, expect, it } from "vitest";
import {
  assetFromMarketplaceCatalogFields,
  assetFromMarketplacePackageSpec,
  marketplacePackageSpecForAsset,
  marketplacePackageTypeForAsset,
  parseMarketplacePackageAsset,
} from "../marketplace-package-assets.js";

describe("marketplace package assets", () => {
  it("parses provider/theme/language package specs into structured assets", () => {
    expect(assetFromMarketplacePackageSpec("provider", "provider:groq"))
      .toEqual({ type: "provider", providerId: "groq" });
    expect(assetFromMarketplacePackageSpec("theme", "theme:tokyo-night"))
      .toEqual({ type: "theme", bundleId: "tokyo-night" });
    expect(assetFromMarketplacePackageSpec("language-pack", "language-pack:ko"))
      .toEqual({ type: "language-pack", locale: "ko" });
  });

  it("accepts explicit catalog asset fields and packageSpec fallbacks", () => {
    expect(parseMarketplacePackageAsset({ type: "provider", provider_id: "ollama" }))
      .toEqual({ type: "provider", providerId: "ollama" });
    expect(parseMarketplacePackageAsset({ type: "theme", package_spec: "theme:high-contrast" }))
      .toEqual({ type: "theme", bundleId: "high-contrast" });
    expect(assetFromMarketplaceCatalogFields("language-pack", "@lvis/ko@1.0.0", {
      locale: "ko",
    })).toEqual({ type: "language-pack", locale: "ko" });
  });

  it("formats structured assets back into marketplace package specs", () => {
    expect(marketplacePackageTypeForAsset({ type: "provider", providerId: "groq" }))
      .toBe("provider");
    expect(marketplacePackageSpecForAsset({ type: "provider", providerId: "groq" }))
      .toBe("provider:groq");
    expect(marketplacePackageSpecForAsset({ type: "theme", bundleId: "tokyo-night" }))
      .toBe("theme:tokyo-night");
    expect(marketplacePackageSpecForAsset({ type: "language-pack", locale: "ko" }))
      .toBe("language-pack:ko");
  });

  it("rejects unknown ids and mismatched package specs", () => {
    expect(assetFromMarketplacePackageSpec("provider", "provider:not-a-vendor"))
      .toBeUndefined();
    expect(assetFromMarketplacePackageSpec("theme", "provider:groq"))
      .toBeUndefined();
    expect(parseMarketplacePackageAsset({ type: "language-pack", locale: "it" }))
      .toBeUndefined();
  });
});
