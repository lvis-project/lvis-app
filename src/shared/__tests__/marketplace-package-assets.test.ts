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
    expect(parseMarketplacePackageAsset({
      type: "theme",
      package_spec: "theme:high-contrast",
      display_name: "High Contrast",
      description: "Accessible theme",
      shell_mode: "dark",
      compatibility_version: "1",
      token_map: {
        "app.background": "#000000",
        "app.foreground": "#ffffff",
      },
    })).toEqual({
      type: "theme",
      bundleId: "high-contrast",
      displayName: "High Contrast",
      description: "Accessible theme",
      shellMode: "dark",
      compatibilityVersion: "1",
      tokens: {
        "app.background": "#000000",
        "app.foreground": "#ffffff",
      },
    });
    expect(assetFromMarketplaceCatalogFields("language-pack", "@lvis/ko@1.0.0", {
      locale: "ko",
      display_name: "Korean",
      native_name: "Korean",
      english_name: "Korean",
      catalog_version: "2026.07",
      messages: {
        "settings.title": "Settings",
      },
    })).toEqual({
      type: "language-pack",
      locale: "ko",
      displayName: "Korean",
      nativeName: "Korean",
      englishName: "Korean",
      catalogVersion: "2026.07",
      messages: {
        "settings.title": "Settings",
      },
    });
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
      model_discovery_policy: "openrouter-models-api",
      capabilities: {
        streaming: true,
        tool_calls: true,
        vision: false,
        reasoning: true,
        reviewer_adapter: true,
      },
      trust_metadata: {
        credential_use: "optional",
        network_access: "router-api",
        data_policy: "router-policy",
      },
    })).toEqual({
      type: "provider",
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free", "future/pro"],
      requiresApiKey: false,
      modelDiscoveryPolicy: "openrouter-models-api",
      capabilities: {
        streaming: true,
        toolCalls: true,
        vision: false,
        reasoning: true,
        reviewerAdapter: true,
      },
      trust: {
        credentialUse: "optional",
        networkAccess: "router-api",
        dataPolicy: "router-policy",
      },
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
      provider_id: "http-keyless-remote-router",
      base_url: "http://router.example/v1",
      default_model: "router/free",
      requires_api_key: false,
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
    expect(parseMarketplacePackageAsset({
      type: "provider",
      provider_id: "http-keyless-loopback-router",
      base_url: "http://127.0.0.1:11434/v1",
      default_model: "local/free",
      requires_api_key: false,
    })).toMatchObject({
      type: "provider",
      providerId: "http-keyless-loopback-router",
      baseUrl: "http://127.0.0.1:11434/v1",
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
