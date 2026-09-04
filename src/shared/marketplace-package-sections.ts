import {
  INSTALLABLE_MARKETPLACE_PACKAGE_TYPES,
  MARKETPLACE_PACKAGE_TYPES,
  type InstallableMarketplacePackageType,
  type MarketplacePackageType,
} from "./assistant-context.js";

export const MARKETPLACE_ASSET_PACKAGE_TYPES = [
  "provider",
  "theme",
  "language-pack",
  "messaging-connection",
] as const satisfies readonly MarketplacePackageType[];

export type MarketplaceAssetPackageType =
  (typeof MARKETPLACE_ASSET_PACKAGE_TYPES)[number];

export type MarketplacePackageFilter = "all" | MarketplacePackageType;

export interface MarketplacePackageFilterOption {
  value: MarketplacePackageFilter;
  label: string;
}

export interface MarketplacePackageSectionDefinition {
  type: MarketplacePackageType;
  label: string;
  installable: boolean;
  uninstallable: boolean;
  assetBacked: boolean;
  trustLabelKeys: readonly string[];
}

export const MARKETPLACE_PACKAGE_TYPE_LABELS: Readonly<Record<MarketplacePackageType, string>> =
  Object.freeze({
    plugin: "Plugins",
    mcp: "MCP",
    agent: "Agents",
    skill: "Skills",
    provider: "Providers",
    theme: "Themes",
    "language-pack": "Languages",
    "messaging-connection": "Messaging",
  });

const INSTALLABLE_PACKAGE_TYPE_SET = new Set<string>(INSTALLABLE_MARKETPLACE_PACKAGE_TYPES);
const MARKETPLACE_ASSET_PACKAGE_TYPE_SET = new Set<string>(MARKETPLACE_ASSET_PACKAGE_TYPES);
const HOST_UNINSTALLABLE_PACKAGE_TYPE_SET = new Set<string>([
  "plugin",
  "mcp",
  "agent",
  "skill",
] satisfies readonly MarketplacePackageType[]);

const MARKETPLACE_ASSET_PACKAGE_TRUST_LABEL_KEYS: Readonly<
  Record<MarketplaceAssetPackageType, readonly string[]>
> = Object.freeze({
  provider: Object.freeze([
    "marketplaceTab.trustProviderCredentials",
    "marketplaceTab.trustProviderNetwork",
  ]),
  theme: Object.freeze([
    "marketplaceTab.trustNoCode",
    "marketplaceTab.trustThemeTokens",
  ]),
  "language-pack": Object.freeze([
    "marketplaceTab.trustNoCode",
    "marketplaceTab.trustLanguageCatalog",
  ]),
  "messaging-connection": Object.freeze([
    "marketplaceTab.trustMessagingCredentials",
    "marketplaceTab.trustMessagingNetwork",
  ]),
});

export function isInstallableMarketplacePackageType(
  value: unknown,
): value is InstallableMarketplacePackageType {
  return typeof value === "string" && INSTALLABLE_PACKAGE_TYPE_SET.has(value);
}

export function isMarketplaceAssetPackageType(
  value: unknown,
): value is MarketplaceAssetPackageType {
  return typeof value === "string" && MARKETPLACE_ASSET_PACKAGE_TYPE_SET.has(value);
}

export function marketplacePackageLabel(packageType: MarketplacePackageType): string {
  return MARKETPLACE_PACKAGE_TYPE_LABELS[packageType];
}

/** The two ways a catalog row can name its kind, as the host reads them. */
export interface MarketplacePackageKindFields {
  readonly pluginType?: MarketplacePackageType;
  /** The kind the catalog declared when this build does not recognise it. */
  readonly unsupportedPackageKind?: string;
}

/**
 * THE reading of a catalog row's kind: the package type to treat it as, or
 * `undefined` when the catalog named a kind this build does not know.
 *
 * The two absent-`pluginType` cases mean opposite things and every consumer has
 * to tell them apart. A row carrying no kind at all predates the field, and
 * every such row was a plugin — so it reads as one. A row that DID name a kind
 * this build cannot honour must never read as a plugin: offering it as an
 * installable one produces an install that can only fail, which is what the
 * fetcher's old coercion did.
 */
export function marketplacePackageTypeOf(
  fields: MarketplacePackageKindFields,
): MarketplacePackageType | undefined {
  if (fields.unsupportedPackageKind !== undefined) return undefined;
  return fields.pluginType ?? "plugin";
}

export function marketplaceTrustLabelKeysForPackage(
  packageType: MarketplacePackageType,
  options: { hasSupportedAsset?: boolean } = {},
): readonly string[] {
  if (options.hasSupportedAsset === false) return [];
  return isMarketplaceAssetPackageType(packageType)
    ? MARKETPLACE_ASSET_PACKAGE_TRUST_LABEL_KEYS[packageType]
    : [];
}

export function canInstallMarketplacePackageType(
  packageType: MarketplacePackageType,
  options: { hasSupportedAsset?: boolean } = {},
): boolean {
  return (
    isInstallableMarketplacePackageType(packageType) ||
    (options.hasSupportedAsset === true && isMarketplaceAssetPackageType(packageType))
  );
}

export function canUninstallMarketplacePackageType(
  packageType: MarketplacePackageType,
  options: { hasSupportedAsset?: boolean } = {},
): boolean {
  return (
    HOST_UNINSTALLABLE_PACKAGE_TYPE_SET.has(packageType) ||
    (options.hasSupportedAsset === true && isMarketplaceAssetPackageType(packageType))
  );
}

export const MARKETPLACE_PACKAGE_SECTIONS: readonly MarketplacePackageSectionDefinition[] =
  Object.freeze(
    MARKETPLACE_PACKAGE_TYPES.map((type) => Object.freeze({
      type,
      label: marketplacePackageLabel(type),
      installable: isInstallableMarketplacePackageType(type),
      uninstallable: canUninstallMarketplacePackageType(type, { hasSupportedAsset: false }),
      assetBacked: isMarketplaceAssetPackageType(type),
      trustLabelKeys: marketplaceTrustLabelKeysForPackage(type),
    })),
  );

export const MARKETPLACE_PACKAGE_FILTER_OPTIONS: readonly MarketplacePackageFilterOption[] =
  Object.freeze([
    { value: "all", label: "All" },
    ...MARKETPLACE_PACKAGE_SECTIONS.map(({ type, label }) => ({
      value: type,
      label,
    })),
  ]);
