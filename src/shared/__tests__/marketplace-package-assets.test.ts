import { describe, expect, it } from "vitest";
import {
  assetFromMarketplaceCatalogFields,
  assetFromMarketplacePackageSpec,
  marketplacePackageSpecForAsset,
  marketplacePackageTypeForAsset,
  parseMarketplacePackageAsset,
  isValidIsoTimestamp,
  marketplaceMessagingConnectionFromAsset,
  normalizeMarketplaceMessagingConnection,
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

  it("preserves catalog metadata for known marketplace provider ids", () => {
    expect(parseMarketplacePackageAsset({
      type: "provider",
      provider_id: "groq",
      label: "Groq",
      base_url: "https://api.groq.com/openai/v1",
      default_model: "moonshotai/kimi-k2-instruct-0905",
      model_options: ["moonshotai/kimi-k2-instruct-0905", "llama-3.3-70b-versatile"],
      model_discovery_policy: "models-api",
      trust_metadata: {
        credential_use: "required",
        network_access: "provider-api",
        data_policy: "provider-policy",
      },
    })).toEqual({
      type: "provider",
      providerId: "groq",
      label: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      defaultModel: "moonshotai/kimi-k2-instruct-0905",
      modelOptions: ["moonshotai/kimi-k2-instruct-0905", "llama-3.3-70b-versatile"],
      requiresApiKey: true,
      modelDiscoveryPolicy: "models-api",
      trust: {
        credentialUse: "required",
        networkAccess: "provider-api",
        dataPolicy: "provider-policy",
      },
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

/**
 * The row the marketplace seeds for Telegram, verbatim. It is the contract this
 * parser exists to accept, so the test carries it whole rather than a reduction.
 */
const TELEGRAM_CONNECTION_ROW = {
  type: "messaging-connection",
  connectionId: "telegram",
  label: "Telegram",
  summary: "Reach one LVIS conversation from Telegram through a private chat with a bot you create yourself.",
  minAppVersion: "0.9.2",
  pairing: "one-time-code",
  credentials: [{
    key: "botToken",
    label: "Bot token",
    secret: true,
    placeholder: "123456:ABC...",
    helpUrl: "https://core.telegram.org/bots#botfather",
  }],
  network: { egress: ["api.telegram.org"] },
  trust: {
    credentialUse: "required",
    networkAccess: "provider-api",
    dataPolicy: "provider-policy",
  },
  docsUrl: "https://core.telegram.org/bots/api",
} as const;

const TELEGRAM_CONNECTION_ASSET = {
  type: "messaging-connection",
  connectionId: "telegram",
  label: "Telegram",
  summary: TELEGRAM_CONNECTION_ROW.summary,
  pairing: "one-time-code",
  credentials: [{
    key: "botToken",
    label: "Bot token",
    secret: true,
    placeholder: "123456:ABC...",
    helpUrl: "https://core.telegram.org/bots#botfather",
  }],
  egress: ["api.telegram.org"],
  trust: {
    credentialUse: "required",
    networkAccess: "provider-api",
    dataPolicy: "provider-policy",
  },
  docsUrl: "https://core.telegram.org/bots/api",
};

describe("messaging-connection package asset", () => {
  it("parses the seeded Telegram row", () => {
    expect(parseMarketplacePackageAsset(TELEGRAM_CONNECTION_ROW))
      .toEqual(TELEGRAM_CONNECTION_ASSET);
  });

  it("reads the same asset off a flat catalog row", () => {
    expect(assetFromMarketplaceCatalogFields(
      "messaging-connection",
      "messaging-connection:telegram",
      { ...TELEGRAM_CONNECTION_ROW },
    )).toEqual(TELEGRAM_CONNECTION_ASSET);
  });

  it("round-trips through the package spec", () => {
    const asset = parseMarketplacePackageAsset(TELEGRAM_CONNECTION_ROW);
    expect(asset && marketplacePackageSpecForAsset(asset))
      .toBe("messaging-connection:telegram");
  });

  it("rejects a row missing any field the card is built from", () => {
    for (const field of ["connectionId", "label", "summary", "pairing", "credentials"] as const) {
      const { [field]: _dropped, ...rest } = TELEGRAM_CONNECTION_ROW;
      expect(parseMarketplacePackageAsset(rest)).toBeUndefined();
    }
  });

  it("rejects a pairing scheme this build cannot run", () => {
    expect(parseMarketplacePackageAsset({
      ...TELEGRAM_CONNECTION_ROW,
      pairing: "oauth-device-code",
    })).toBeUndefined();
  });

  it("rejects the whole row when one credential is malformed", () => {
    expect(parseMarketplacePackageAsset({
      ...TELEGRAM_CONNECTION_ROW,
      credentials: [
        TELEGRAM_CONNECTION_ROW.credentials[0],
        { key: "webhookSecret", label: "Webhook secret" },
      ],
    })).toBeUndefined();
    expect(parseMarketplacePackageAsset({
      ...TELEGRAM_CONNECTION_ROW,
      credentials: [],
    })).toBeUndefined();
  });

  it("rejects a network disclosure it cannot read rather than dropping it", () => {
    for (const network of [{ egress: ["*"] }, { egress: ["https://api.telegram.org/x"] }, { egress: [] }, {}]) {
      expect(parseMarketplacePackageAsset({ ...TELEGRAM_CONNECTION_ROW, network }))
        .toBeUndefined();
    }
  });

  it("carries no field the contract does not name, including a credential value", () => {
    const asset = parseMarketplacePackageAsset({
      ...TELEGRAM_CONNECTION_ROW,
      credentials: [{ ...TELEGRAM_CONNECTION_ROW.credentials[0], value: "123456:REAL-TOKEN" }],
    });
    expect(asset).toEqual(TELEGRAM_CONNECTION_ASSET);
    expect(JSON.stringify(asset)).not.toContain("REAL-TOKEN");
  });

  it("cannot be named by a bare package spec, which describes nothing", () => {
    expect(assetFromMarketplacePackageSpec(
      "messaging-connection",
      "messaging-connection:telegram",
    )).toBeUndefined();
  });
});

describe("installed messaging connection record", () => {
  it("rebuilds the declaration and drops everything else", () => {
    const asset = parseMarketplacePackageAsset(TELEGRAM_CONNECTION_ROW);
    const { type: _type, ...declaration } = TELEGRAM_CONNECTION_ASSET;
    expect(marketplaceMessagingConnectionFromAsset(asset)).toEqual(declaration);
    expect(normalizeMarketplaceMessagingConnection({
      ...declaration,
      botToken: "123456:REAL-TOKEN",
    })).toEqual(declaration);
  });

  it("refuses an asset of another kind", () => {
    expect(marketplaceMessagingConnectionFromAsset({ type: "theme", bundleId: "tokyo-night" }))
      .toBeUndefined();
  });
});

describe("isValidIsoTimestamp", () => {
  it("accepts instants Date.parse understands and rejects everything else", () => {
    expect(isValidIsoTimestamp("2026-01-02T03:04:05Z")).toBe(true);
    expect(isValidIsoTimestamp("2026-01-02T03:04:05.123+09:00")).toBe(true);
    expect(isValidIsoTimestamp("")).toBe(false);
    expect(isValidIsoTimestamp("not a date")).toBe(false);
    expect(isValidIsoTimestamp(1_700_000_000_000)).toBe(false);
    expect(isValidIsoTimestamp(undefined)).toBe(false);
  });
});
