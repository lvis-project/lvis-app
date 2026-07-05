import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISIBLE_LOCALES,
  MARKETPLACE_ELIGIBLE_LOCALES,
} from "../../../i18n/index.js";
import {
  DEFAULT_VISIBLE_LLM_VENDOR_IDS,
  MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS,
} from "../../../shared/llm-vendor-defaults.js";
import {
  DEFAULT_VISIBLE_THEME_BUNDLE_IDS,
  MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS,
} from "../../../shared/theme-bundles.js";
import { marketplacePackageSpecForAsset } from "../../../shared/marketplace-package-assets.js";
import { LOCAL_MARKETPLACE_ASSET_ENTRIES } from "../marketplace-asset-registry.js";

describe("marketplace asset registry", () => {
  it("registers every marketplace-eligible provider, theme, and language once", () => {
    const providerSpecs = LOCAL_MARKETPLACE_ASSET_ENTRIES
      .filter((entry) => entry.packageType === "provider")
      .map((entry) => entry.packageSpec);
    const themeSpecs = LOCAL_MARKETPLACE_ASSET_ENTRIES
      .filter((entry) => entry.packageType === "theme")
      .map((entry) => entry.packageSpec);
    const languageSpecs = LOCAL_MARKETPLACE_ASSET_ENTRIES
      .filter((entry) => entry.packageType === "language-pack")
      .map((entry) => entry.packageSpec);

    expect(providerSpecs).toEqual(
      MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS.map((id) => `provider:${id}`),
    );
    expect(themeSpecs).toEqual(
      MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS.map((id) => `theme:${id}`),
    );
    expect(languageSpecs).toEqual(
      MARKETPLACE_ELIGIBLE_LOCALES.map((locale) => `language-pack:${locale}`),
    );
    expect(new Set(LOCAL_MARKETPLACE_ASSET_ENTRIES.map((entry) => entry.packageSpec)).size)
      .toBe(LOCAL_MARKETPLACE_ASSET_ENTRIES.length);
  });

  it("does not register default-surface assets as marketplace-local packages", () => {
    const specs = LOCAL_MARKETPLACE_ASSET_ENTRIES.map((entry) => entry.packageSpec);

    for (const providerId of DEFAULT_VISIBLE_LLM_VENDOR_IDS) {
      expect(specs).not.toContain(`provider:${providerId}`);
    }
    for (const bundleId of DEFAULT_VISIBLE_THEME_BUNDLE_IDS) {
      expect(specs).not.toContain(`theme:${bundleId}`);
    }
    for (const locale of DEFAULT_VISIBLE_LOCALES) {
      expect(specs).not.toContain(`language-pack:${locale}`);
    }
  });

  it("keeps package metadata derived from the structured asset", () => {
    for (const entry of LOCAL_MARKETPLACE_ASSET_ENTRIES) {
      expect(entry.packageType).toBe(entry.asset.type);
      expect(entry.packageSpec).toBe(marketplacePackageSpecForAsset(entry.asset));
    }
  });
});
