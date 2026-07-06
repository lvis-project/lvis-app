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

  it("accepts custom provider preset metadata for user-authored marketplace assets", () => {
    expect(parseMarketplacePackageAsset({
      type: "provider",
      provider_id: "future-router",
      label: "Future Router",
      base_url: "https://future.example/v1",
      default_model: "future/free",
      model_options: ["future/free", "future/pro", "future/free"],
      requires_api_key: false,
    })).toEqual({
      type: "provider",
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free", "future/pro"],
      requiresApiKey: false,
    });
    expect(assetFromMarketplaceCatalogFields("provider", "provider:top-level-router", {
      label: "Top-level Router",
      baseUrl: "https://top-level.example/v1",
      defaultModel: "top/free",
    })).toEqual({
      type: "provider",
      providerId: "top-level-router",
      label: "Top-level Router",
      baseUrl: "https://top-level.example/v1",
      defaultModel: "top/free",
      modelOptions: ["top/free"],
      requiresApiKey: true,
    });
  });

  it("requires https for custom provider presets that use API keys", () => {
    expect(parseMarketplacePackageAsset({
      type: "provider",
      provider_id: "http-keyed-router",
      base_url: "http://router.example/v1",
      default_model: "router/free",
      requires_api_key: true,
    })).toBeUndefined();
    expect(parseMarketplacePackageAsset({
      type: "provider",
      provider_id: "http-keyless-router",
      base_url: "http://localhost:11434/v1",
      default_model: "local/free",
      requires_api_key: false,
    })).toEqual({
      type: "provider",
      providerId: "http-keyless-router",
      label: "Http Keyless Router",
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "local/free",
      modelOptions: ["local/free"],
      requiresApiKey: false,
    });
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

  it("rejects unknown ids without preset metadata and mismatched package specs", () => {
    expect(assetFromMarketplacePackageSpec("provider", "provider:not-a-vendor"))
      .toBeUndefined();
    expect(assetFromMarketplacePackageSpec("theme", "provider:groq"))
      .toBeUndefined();
    expect(parseMarketplacePackageAsset({ type: "language-pack", locale: "it" }))
      .toBeUndefined();
  });

  it("rejects default-surface ids at the marketplace catalog boundary", () => {
    expect(assetFromMarketplacePackageSpec("provider", "provider:openai"))
      .toBeUndefined();
    expect(assetFromMarketplacePackageSpec("provider", "provider:openrouter"))
      .toBeUndefined();
    expect(assetFromMarketplacePackageSpec("theme", "theme:moonstone"))
      .toBeUndefined();
    expect(assetFromMarketplacePackageSpec("theme", "theme:gallery"))
      .toBeUndefined();
    expect(assetFromMarketplacePackageSpec("language-pack", "language-pack:en"))
      .toBeUndefined();
    expect(parseMarketplacePackageAsset({ type: "provider", provider_id: "openai" }))
      .toBeUndefined();
    expect(parseMarketplacePackageAsset({ type: "theme", bundle_id: "moonstone" }))
      .toBeUndefined();
    expect(parseMarketplacePackageAsset({ type: "language-pack", locale: "en" }))
      .toBeUndefined();
  });
});
