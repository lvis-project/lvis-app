import { describe, expect, it } from "vitest";
import { MARKETPLACE_PACKAGE_TYPES } from "../assistant-context.js";
import {
  MARKETPLACE_ASSET_PACKAGE_TYPES,
  MARKETPLACE_PACKAGE_FILTER_OPTIONS,
  MARKETPLACE_PACKAGE_SECTIONS,
  canInstallMarketplacePackageType,
  canUninstallMarketplacePackageType,
  isMarketplaceAssetPackageType,
  isInstallableMarketplacePackageType,
  marketplacePackageLabel,
  marketplaceTrustLabelKeysForPackage,
} from "../marketplace-package-sections.js";

describe("marketplace package sections", () => {
  it("defines one catalog section per marketplace package type", () => {
    expect(MARKETPLACE_PACKAGE_SECTIONS.map((section) => section.type))
      .toEqual(MARKETPLACE_PACKAGE_TYPES);
    expect(MARKETPLACE_PACKAGE_FILTER_OPTIONS.map((option) => option.value))
      .toEqual(["all", ...MARKETPLACE_PACKAGE_TYPES]);
  });

  it("keeps provider, theme, and language pack as settings-backed asset sections", () => {
    expect(MARKETPLACE_ASSET_PACKAGE_TYPES)
      .toEqual(["provider", "theme", "language-pack"]);
    expect(isMarketplaceAssetPackageType("provider")).toBe(true);
    expect(isMarketplaceAssetPackageType("theme")).toBe(true);
    expect(isMarketplaceAssetPackageType("language-pack")).toBe(true);
    expect(isMarketplaceAssetPackageType("plugin")).toBe(false);
    expect(isMarketplaceAssetPackageType("language")).toBe(false);
  });

  it("centralizes labels and trust badges for marketplace UI rows", () => {
    expect(marketplacePackageLabel("provider")).toBe("Providers");
    expect(marketplacePackageLabel("language-pack")).toBe("Languages");
    expect(marketplaceTrustLabelKeysForPackage("provider")).toEqual([
      "marketplaceTab.trustProviderCredentials",
      "marketplaceTab.trustProviderNetwork",
    ]);
    expect(marketplaceTrustLabelKeysForPackage("theme")).toEqual([
      "marketplaceTab.trustNoCode",
      "marketplaceTab.trustThemeTokens",
    ]);
    expect(marketplaceTrustLabelKeysForPackage("language-pack")).toEqual([
      "marketplaceTab.trustNoCode",
      "marketplaceTab.trustLanguageCatalog",
    ]);
    expect(marketplaceTrustLabelKeysForPackage("provider", { hasSupportedAsset: false }))
      .toEqual([]);
    expect(marketplaceTrustLabelKeysForPackage("plugin")).toEqual([]);
  });

  it("keeps host-artifact and settings-asset install policies separate", () => {
    expect(isInstallableMarketplacePackageType("plugin")).toBe(true);
    expect(isInstallableMarketplacePackageType("mcp")).toBe(true);
    expect(isInstallableMarketplacePackageType("provider")).toBe(false);

    expect(canInstallMarketplacePackageType("mcp")).toBe(true);
    expect(canUninstallMarketplacePackageType("mcp")).toBe(true);
    expect(canUninstallMarketplacePackageType("plugin")).toBe(true);

    expect(canInstallMarketplacePackageType("provider")).toBe(false);
    expect(canInstallMarketplacePackageType("provider", { hasSupportedAsset: true }))
      .toBe(true);
    expect(canUninstallMarketplacePackageType("provider")).toBe(false);
    expect(canUninstallMarketplacePackageType("provider", { hasSupportedAsset: true }))
      .toBe(true);
  });
});
