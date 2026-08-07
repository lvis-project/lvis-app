import {
  isMarketplaceEligibleLocale,
  type MarketplaceEligibleLocale,
} from "../i18n/locale.js";
import {
  type MarketplacePackageType,
} from "./assistant-context.js";
import {
  isMarketplaceAssetPackageType,
} from "./marketplace-package-sections.js";
import {
  isMarketplaceEligibleLLMVendor,
  isLLMVendor,
} from "./llm-vendor-defaults.js";
import {
  isMarketplaceEligibleThemeBundleId,
  type MarketplaceEligibleThemeBundleId,
} from "./theme-bundles.js";

export interface MarketplaceProviderPackageAsset {
  type: "provider";
  providerId: string;
  label?: string;
  baseUrl?: string;
  apiKeyPlaceholder?: string;
  defaultModel?: string;
  modelOptions?: string[];
  requiresApiKey?: boolean;
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
  capabilities?: MarketplaceProviderPackageCapabilities;
  trust?: MarketplaceProviderPackageTrustMetadata;
}

export interface MarketplaceInstalledProviderPreset {
  providerId: string;
  label: string;
  baseUrl: string;
  apiKeyPlaceholder?: string;
  defaultModel: string;
  modelOptions: string[];
  requiresApiKey: boolean;
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
  capabilities?: MarketplaceProviderPackageCapabilities;
  trust?: MarketplaceProviderPackageTrustMetadata;
}

export const MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES = [
  "static",
  "models-api",
  "openrouter-models-api",
  "manual",
] as const;

export type MarketplaceProviderModelDiscoveryPolicy =
  (typeof MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES)[number];

/**
 * What each discovery policy permits. Two independent columns, not one flag:
 * "may the host fetch the model list over the network" and "does this preset
 * ship its own model list" are separate questions. Today's four values happen
 * to occupy the diagonal (every fetching policy is unseeded and vice versa),
 * which is exactly why three hand-written predicates could disagree only in
 * the abstract — and why collapsing them to a single boolean would destroy
 * expressible behaviour.
 *
 * `satisfies Record<...>` is the point of this table: adding a member to
 * `MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES` is a compile error until its
 * behaviour is declared here, so a new policy can no longer be accepted at
 * ingest (`cleanEnum`, below) while the deciding predicates are never revisited.
 */
export interface MarketplaceProviderModelDiscoveryBehavior {
  /** The host may fetch this provider's model list over the network. */
  allowsFetch: boolean;
  /** The preset supplies its model options; a cached fetched list is meaningless. */
  usesSeededOptions: boolean;
}

export const MARKETPLACE_PROVIDER_MODEL_DISCOVERY_BEHAVIOR = {
  static: { allowsFetch: false, usesSeededOptions: true },
  "models-api": { allowsFetch: true, usesSeededOptions: false },
  "openrouter-models-api": { allowsFetch: true, usesSeededOptions: false },
  manual: { allowsFetch: false, usesSeededOptions: true },
} as const satisfies Record<
  MarketplaceProviderModelDiscoveryPolicy,
  MarketplaceProviderModelDiscoveryBehavior
>;

/**
 * An absent policy is the legacy default: a plain provider with no marketplace
 * preset opinion, which discovers its models over the network. Both ingest
 * paths normalize an out-of-union string to `undefined`, so unrecognized input
 * lands here rather than in the table.
 */
const UNDECLARED_MODEL_DISCOVERY_BEHAVIOR: MarketplaceProviderModelDiscoveryBehavior = {
  allowsFetch: true,
  usesSeededOptions: false,
};

function marketplaceProviderModelDiscoveryBehavior(
  policy: MarketplaceProviderModelDiscoveryPolicy | undefined,
): MarketplaceProviderModelDiscoveryBehavior {
  if (policy === undefined) return UNDECLARED_MODEL_DISCOVERY_BEHAVIOR;
  return (
    MARKETPLACE_PROVIDER_MODEL_DISCOVERY_BEHAVIOR[policy] ??
    UNDECLARED_MODEL_DISCOVERY_BEHAVIOR
  );
}

/** The host may fetch this provider's model list over the network. */
export function modelDiscoveryPolicyAllowsFetch(
  policy: MarketplaceProviderModelDiscoveryPolicy | undefined,
): boolean {
  return marketplaceProviderModelDiscoveryBehavior(policy).allowsFetch;
}

/** The preset supplies its model options rather than discovering them. */
export function modelDiscoveryPolicyUsesSeededOptions(
  policy: MarketplaceProviderModelDiscoveryPolicy | undefined,
): boolean {
  return marketplaceProviderModelDiscoveryBehavior(policy).usesSeededOptions;
}

export interface MarketplaceProviderPackageCapabilities {
  streaming?: boolean;
  toolCalls?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  localOnly?: boolean;
  reviewerAdapter?: boolean;
}

export interface MarketplaceProviderPackageTrustMetadata {
  credentialUse?: "none" | "optional" | "required";
  networkAccess?: "none" | "local" | "provider-api" | "router-api";
  dataPolicy?: "local-only" | "provider-policy" | "router-policy";
}

export type MarketplaceThemeShellMode = "light" | "dark" | "system";

export interface MarketplaceThemePackageAsset {
  type: "theme";
  bundleId: MarketplaceEligibleThemeBundleId;
  displayName?: string;
  description?: string;
  shellMode?: MarketplaceThemeShellMode;
  compatibilityVersion?: string;
  tokens?: Record<string, string>;
}

export interface MarketplaceLanguagePackPackageAsset {
  type: "language-pack";
  locale: MarketplaceEligibleLocale;
  displayName?: string;
  nativeName?: string;
  englishName?: string;
  catalogVersion?: string;
  messages?: Record<string, string>;
}

export type MarketplacePackageAsset =
  | MarketplaceProviderPackageAsset
  | MarketplaceThemePackageAsset
  | MarketplaceLanguagePackPackageAsset;

export type MarketplacePackageAssetType = MarketplacePackageAsset["type"];

const MARKETPLACE_PROVIDER_PRESET_SECRET_ID_PREFIX = "marketplace-provider:";
const MARKETPLACE_PROVIDER_PRESET_SECRET_KEY_PREFIX = "llm.marketplaceProvider.";
export const MARKETPLACE_PROVIDER_PRESET_ID_MAX_LENGTH = 80;
export const MARKETPLACE_PROVIDER_PRESET_ID_PATTERN_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]*";
const MAX_PROVIDER_LABEL_LENGTH = 80;
const MAX_PROVIDER_URL_LENGTH = 512;
const MAX_PROVIDER_MODEL_LENGTH = 256;
const MAX_PROVIDER_MODEL_OPTIONS = 100;
const MAX_PACKAGE_METADATA_LENGTH = 256;
const MAX_PACKAGE_METADATA_VALUE_LENGTH = 4_000;
const MAX_THEME_TOKENS = 500;
const MAX_LANGUAGE_MESSAGES = 10_000;
const MARKETPLACE_PROVIDER_PRESET_ID_PATTERN =
  new RegExp(`^${MARKETPLACE_PROVIDER_PRESET_ID_PATTERN_SOURCE}$`);

export function isMarketplaceProviderPresetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MARKETPLACE_PROVIDER_PRESET_ID_MAX_LENGTH &&
    MARKETPLACE_PROVIDER_PRESET_ID_PATTERN.test(value)
  );
}

function normalizeProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return isMarketplaceProviderPresetId(trimmed) ? trimmed : undefined;
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function cleanUrl(value: unknown): string | undefined {
  const trimmed = cleanString(value, MAX_PROVIDER_URL_LENGTH);
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

function usesHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function usesLoopbackHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "[::1]") return true;

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

function isAllowedProviderBaseUrl(value: string, requiresApiKey: boolean): boolean {
  return usesHttpsUrl(value) || (!requiresApiKey && usesLoopbackHttpUrl(value));
}

function cleanModelOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const options: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const model = cleanString(raw, MAX_PROVIDER_MODEL_LENGTH);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    options.push(model);
    if (options.length >= MAX_PROVIDER_MODEL_OPTIONS) break;
  }
  return options;
}

function cleanEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (allowed as readonly string[]).includes(trimmed) ? trimmed as T : undefined;
}

function cleanStringRecord(
  value: unknown,
  maxEntries: number,
  maxValueLength = MAX_PACKAGE_METADATA_LENGTH,
): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = cleanString(rawKey, MAX_PACKAGE_METADATA_LENGTH);
    const entryValue = cleanString(rawValue, maxValueLength);
    if (!key || entryValue === undefined) continue;
    result[key] = entryValue;
    if (Object.keys(result).length >= maxEntries) break;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function cleanCapabilities(
  value: unknown,
): MarketplaceProviderPackageCapabilities | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const capabilities: MarketplaceProviderPackageCapabilities = {};
  for (const [field, target] of [
    ["streaming", "streaming"],
    ["toolCalls", "toolCalls"],
    ["tool_calls", "toolCalls"],
    ["vision", "vision"],
    ["reasoning", "reasoning"],
    ["localOnly", "localOnly"],
    ["local_only", "localOnly"],
    ["reviewerAdapter", "reviewerAdapter"],
    ["reviewer_adapter", "reviewerAdapter"],
    ["reviewer", "reviewerAdapter"],
  ] as const) {
    if (typeof record[field] === "boolean") {
      capabilities[target] = record[field];
    }
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function cleanTrustMetadata(
  value: unknown,
): MarketplaceProviderPackageTrustMetadata | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const credentialUse = cleanEnum(record.credentialUse ?? record.credential_use, [
    "none",
    "optional",
    "required",
  ] as const);
  const networkAccess = cleanEnum(record.networkAccess ?? record.network_access, [
    "none",
    "local",
    "provider-api",
    "router-api",
  ] as const);
  const dataPolicy = cleanEnum(record.dataPolicy ?? record.data_policy, [
    "local-only",
    "provider-policy",
    "router-policy",
  ] as const);
  const trust: MarketplaceProviderPackageTrustMetadata = {};
  if (credentialUse) trust.credentialUse = credentialUse;
  if (networkAccess) trust.networkAccess = networkAccess;
  if (dataPolicy) trust.dataPolicy = dataPolicy;
  return Object.keys(trust).length > 0 ? trust : undefined;
}

function humanizeProviderId(providerId: string): string {
  return providerId
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || providerId;
}

function providerPresetFieldsFromRecord(
  providerId: string,
  record: Record<string, unknown>,
): Omit<MarketplaceInstalledProviderPreset, "providerId"> | undefined {
  const label = cleanString(
    record.label ?? record.name ?? record.displayName ?? record.display_name ?? record.providerName ?? record.provider_name,
    MAX_PROVIDER_LABEL_LENGTH,
  ) ?? humanizeProviderId(providerId);
  const baseUrl = cleanUrl(
    record.baseUrl ?? record.base_url ?? record.endpoint ?? record.apiBaseUrl ?? record.api_base_url,
  );
  const modelOptions = cleanModelOptions(
    record.modelOptions ?? record.model_options ?? record.models,
  );
  const defaultModel = cleanString(
    record.defaultModel ?? record.default_model ?? record.model,
    MAX_PROVIDER_MODEL_LENGTH,
  ) ?? modelOptions[0];
  const apiKeyPlaceholder = cleanString(
    record.apiKeyPlaceholder ?? record.api_key_placeholder ?? record.keyPlaceholder ?? record.key_placeholder,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const requiresApiKey =
    typeof record.requiresApiKey === "boolean"
      ? record.requiresApiKey
      : typeof record.requires_api_key === "boolean"
        ? record.requires_api_key
        : typeof record.apiKeyRequired === "boolean"
          ? record.apiKeyRequired
          : typeof record.api_key_required === "boolean"
            ? record.api_key_required
            : true;
  if (!baseUrl || !defaultModel) return undefined;
  if (!isAllowedProviderBaseUrl(baseUrl, requiresApiKey)) return undefined;
  const normalizedOptions = modelOptions.includes(defaultModel)
    ? modelOptions
    : [defaultModel, ...modelOptions];
  const modelDiscoveryPolicy = cleanEnum(
    record.modelDiscoveryPolicy ??
      record.model_discovery_policy ??
      record.modelDiscovery ??
      record.model_discovery,
    MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES,
  );
  const capabilities = cleanCapabilities(record.capabilities);
  const trust = cleanTrustMetadata(
    record.trust ?? record.trustMetadata ?? record.trust_metadata,
  );
  return {
    label,
    baseUrl,
    ...(apiKeyPlaceholder ? { apiKeyPlaceholder } : {}),
    defaultModel,
    modelOptions: normalizedOptions,
    requiresApiKey,
    ...(modelDiscoveryPolicy ? { modelDiscoveryPolicy } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(trust ? { trust } : {}),
  };
}

function providerPackageFieldsFromRecord(
  providerId: string,
  record: Record<string, unknown>,
): Omit<MarketplaceProviderPackageAsset, "type" | "providerId"> | undefined {
  const presetFields = providerPresetFieldsFromRecord(providerId, record);
  if (!presetFields) return undefined;
  return presetFields;
}

export function normalizeMarketplaceProviderPreset(
  value: unknown,
): MarketplaceInstalledProviderPreset | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const providerId = normalizeProviderId(
    record.providerId ?? record.provider_id ?? record.id,
  );
  if (!providerId || isLLMVendor(providerId)) return undefined;
  const fields = providerPresetFieldsFromRecord(providerId, record);
  return fields ? { providerId, ...fields } : undefined;
}

export function marketplaceProviderPresetFromAsset(
  asset: MarketplacePackageAsset | undefined,
  fallbackLabel?: string,
): MarketplaceInstalledProviderPreset | undefined {
  if (!asset || asset.type !== "provider") return undefined;
  if (isLLMVendor(asset.providerId)) return undefined;
  return normalizeMarketplaceProviderPreset({
    ...asset,
    ...(fallbackLabel && !asset.label ? { label: fallbackLabel } : {}),
  });
}

export function marketplaceProviderPresetSecretId(providerId: string): string {
  return `${MARKETPLACE_PROVIDER_PRESET_SECRET_ID_PREFIX}${providerId}`;
}

export function marketplaceProviderPresetIdFromSecretId(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith(MARKETPLACE_PROVIDER_PRESET_SECRET_ID_PREFIX)) {
    return undefined;
  }
  return normalizeProviderId(
    value.slice(MARKETPLACE_PROVIDER_PRESET_SECRET_ID_PREFIX.length),
  );
}

export function marketplaceProviderPresetSecretKey(providerId: string): string {
  return `${MARKETPLACE_PROVIDER_PRESET_SECRET_KEY_PREFIX}${providerId}.apiKey`;
}

/** `llm.apiKey.<vendor>` — the non-marketplace host-secret key family. */
const LLM_API_KEY_PATTERN = /^llm\.apiKey\.[a-z]+(?:-[a-z]+)*$/;

/**
 * Per-item bound from `schemas/plugin-manifest.schema.json`
 * (`hostSecrets.read.items.maxLength`). The marketplace branch is additionally
 * bounded by {@link MARKETPLACE_PROVIDER_PRESET_ID_MAX_LENGTH} via
 * {@link isMarketplaceProviderPresetId}; this caps the vendor branch too, the
 * way AJV does.
 */
const HOST_SECRET_KEY_MAX_LENGTH = 111;

/**
 * THE shape gate for a `hostSecrets.read[]` entry — "is this a well-formed
 * host-secret key a plugin is permitted to name?".
 *
 * One definition for both runtime enforcement points: plugin manifests
 * (`src/plugins/runtime/manifest-validation.ts`) and signed whitelist grants
 * (`src/plugins/whitelist/whitelist-schema.ts`), which previously carried
 * byte-identical private copies.
 *
 * Deliberately validates the RAW preset-id segment. Both former copies routed
 * this branch through a `marketplaceProviderPresetIdFromSecretKey` helper that
 * `.trim()`ed the segment — correct when RESOLVING an id, wrong when
 * VALIDATING a declared key. The trim made the runtime gate accept
 * `llm.marketplaceProvider.<spaces>foo<spaces>.apiKey`, which the JSON schema
 * rejects, i.e. the TS mirror was LOOSER than the schema it exists to mirror.
 * That helper had no other consumer and is gone. Slicing the raw segment and
 * asking {@link isMarketplaceProviderPresetId} is also exactly what the Tier-4
 * cross-check in `host-api-factory.ts` does, so the declared key and the key
 * the gate later compares are now judged by one rule.
 */
export function isAllowedHostSecretKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > HOST_SECRET_KEY_MAX_LENGTH) {
    return false;
  }
  if (LLM_API_KEY_PATTERN.test(value)) return true;
  if (
    !value.startsWith(MARKETPLACE_PROVIDER_PRESET_SECRET_KEY_PREFIX) ||
    !value.endsWith(".apiKey")
  ) {
    return false;
  }
  return isMarketplaceProviderPresetId(
    value.slice(
      MARKETPLACE_PROVIDER_PRESET_SECRET_KEY_PREFIX.length,
      -".apiKey".length,
    ),
  );
}

/**
 * Collection bound from `schemas/plugin-manifest.schema.json`
 * (`hostSecrets.read.maxItems`). Declared rather than imported from the schema
 * JSON: this module is renderer-reachable and the schema is a ~38 KB JSON
 * module. The two values are pinned to each other by an executed test
 * (`src/plugins/runtime/__tests__/host-secrets-manifest.test.ts`), which reads
 * the schema from disk — so a schema edit that is not mirrored here fails CI.
 */
export const HOST_SECRET_READ_MAX_ITEMS = 32;

/** What {@link findHostSecretReadListViolation} found, if anything. */
export type HostSecretReadListViolation =
  | { readonly kind: "maxItems"; readonly count: number }
  | { readonly kind: "duplicate"; readonly index: number; readonly key: string };

/**
 * THE collection gate for a `hostSecrets.read[]` array — the counterpart of
 * {@link isAllowedHostSecretKey}, which judges one entry at a time and so can
 * see neither `maxItems` nor `uniqueItems`.
 *
 * One definition for both runtime enforcement points, for the same reason the
 * per-item predicate has one: a signed whitelist grant and a manifest must not
 * be able to disagree about how large a host-secret allowlist may be. On the
 * manifest path AJV enforces the same two bounds against the vendored schema,
 * so this is defence-in-depth there; on the signed-whitelist path
 * (`parseWhitelistDocument`) there is no schema leg at all and this is the only
 * gate (#1939).
 *
 * Reports the first violation rather than throwing: the two call sites raise
 * differently shaped errors (`fail()` vs a `[whitelist]`-prefixed throw), and
 * both reject the document — a signed grant is never silently trimmed, since
 * that would enforce something other than what was signed.
 */
export function findHostSecretReadListViolation(
  keys: readonly string[],
): HostSecretReadListViolation | undefined {
  if (keys.length > HOST_SECRET_READ_MAX_ITEMS) {
    return { kind: "maxItems", count: keys.length };
  }
  const seen = new Set<string>();
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (seen.has(key)) return { kind: "duplicate", index: i, key };
    seen.add(key);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function normalizeAssetType(
  value: unknown,
): MarketplacePackageAssetType | undefined {
  const normalized: unknown = value === "language" ? "language-pack" : value;
  return isMarketplaceAssetPackageType(normalized) ? normalized : undefined;
}

export function marketplacePackageTypeForAsset(
  asset: MarketplacePackageAsset,
): MarketplacePackageAssetType {
  return asset.type;
}

export function marketplacePackageSpecForAsset(
  asset: MarketplacePackageAsset,
): string {
  if (asset.type === "provider") return `provider:${asset.providerId}`;
  if (asset.type === "theme") return `theme:${asset.bundleId}`;
  return `language-pack:${asset.locale}`;
}

function providerAsset(
  providerId: unknown,
  metadata?: Record<string, unknown>,
): MarketplacePackageAsset | undefined {
  const id = normalizeProviderId(providerId);
  if (!id) return undefined;
  if (isLLMVendor(id)) {
    if (!isMarketplaceEligibleLLMVendor(id)) return undefined;
    if (!metadata) return { type: "provider", providerId: id };
    const fields = providerPackageFieldsFromRecord(id, metadata);
    return fields
      ? { type: "provider", providerId: id, ...fields }
      : { type: "provider", providerId: id };
  }
  if (!metadata) return undefined;
  const fields = providerPackageFieldsFromRecord(id, metadata);
  return fields ? { type: "provider", providerId: id, ...fields } : undefined;
}

function themeAsset(
  bundleId: unknown,
  metadata?: Record<string, unknown>,
): MarketplaceThemePackageAsset | undefined {
  if (!isMarketplaceEligibleThemeBundleId(bundleId)) return undefined;
  if (!metadata) return { type: "theme", bundleId };
  const displayName = cleanString(
    metadata.displayName ?? metadata.display_name ?? metadata.name,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const description = cleanString(metadata.description, MAX_PACKAGE_METADATA_LENGTH);
  const shellMode = cleanEnum(metadata.shellMode ?? metadata.shell_mode, [
    "light",
    "dark",
    "system",
  ] as const);
  const compatibilityVersion = cleanString(
    metadata.compatibilityVersion ?? metadata.compatibility_version,
    MAX_PACKAGE_METADATA_LENGTH,
  );
  const tokens = cleanStringRecord(
    metadata.tokens ?? metadata.tokenMap ?? metadata.token_map,
    MAX_THEME_TOKENS,
    MAX_PACKAGE_METADATA_LENGTH,
  );
  return {
    type: "theme",
    bundleId,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(shellMode ? { shellMode } : {}),
    ...(compatibilityVersion ? { compatibilityVersion } : {}),
    ...(tokens ? { tokens } : {}),
  };
}

function languagePackAsset(
  locale: unknown,
  metadata?: Record<string, unknown>,
): MarketplaceLanguagePackPackageAsset | undefined {
  if (!isMarketplaceEligibleLocale(locale)) return undefined;
  if (!metadata) return { type: "language-pack", locale };
  const displayName = cleanString(
    metadata.displayName ?? metadata.display_name ?? metadata.name,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const nativeName = cleanString(
    metadata.nativeName ?? metadata.native_name,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const englishName = cleanString(
    metadata.englishName ?? metadata.english_name,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const catalogVersion = cleanString(
    metadata.catalogVersion ?? metadata.catalog_version,
    MAX_PACKAGE_METADATA_LENGTH,
  );
  const messages = cleanStringRecord(
    metadata.messages ?? metadata.catalog ?? metadata.message_catalog,
    MAX_LANGUAGE_MESSAGES,
    MAX_PACKAGE_METADATA_VALUE_LENGTH,
  );
  return {
    type: "language-pack",
    locale,
    ...(displayName ? { displayName } : {}),
    ...(nativeName ? { nativeName } : {}),
    ...(englishName ? { englishName } : {}),
    ...(catalogVersion ? { catalogVersion } : {}),
    ...(messages ? { messages } : {}),
  };
}

export function assetFromMarketplacePackageSpec(
  pluginType: MarketplacePackageType | undefined,
  packageSpec: string,
  metadata?: Record<string, unknown>,
): MarketplacePackageAsset | undefined {
  const separatorIndex = packageSpec.indexOf(":");
  if (separatorIndex <= 0) return undefined;

  const prefix = packageSpec.slice(0, separatorIndex);
  const value = packageSpec.slice(separatorIndex + 1);
  const type = pluginType === undefined
    ? normalizeAssetType(prefix)
    : normalizeAssetType(pluginType);

  if (!type || prefix !== type) return undefined;
  if (type === "provider") return providerAsset(value, metadata);
  if (type === "theme") return themeAsset(value, metadata);
  return languagePackAsset(value, metadata);
}

function providerAssetFromMarketplacePackageSpec(
  pluginType: MarketplacePackageType | undefined,
  packageSpec: string,
  metadata: Record<string, unknown>,
): MarketplacePackageAsset | undefined {
  const separatorIndex = packageSpec.indexOf(":");
  if (separatorIndex <= 0) return undefined;
  const prefix = packageSpec.slice(0, separatorIndex);
  const value = packageSpec.slice(separatorIndex + 1);
  const type = pluginType === undefined
    ? normalizeAssetType(prefix)
    : normalizeAssetType(pluginType);
  if (type !== "provider" || prefix !== type) return undefined;
  return providerAsset(value, metadata);
}

export function parseMarketplacePackageAsset(
  value: unknown,
): MarketplacePackageAsset | undefined {
  if (typeof value === "string") {
    return assetFromMarketplacePackageSpec(undefined, value);
  }

  const record = asRecord(value);
  if (!record) return undefined;

  const type = normalizeAssetType(
    record.type ??
      record.kind ??
      record.pluginType ??
      record.plugin_type ??
      record.packageType ??
      record.package_type,
  );
  if (!type) return undefined;
  const packageSpec = stringField(record, ["packageSpec", "package_spec"]);

  if (type === "provider") {
    return providerAsset(
      stringField(record, [
        "providerId",
        "provider_id",
        "vendorId",
        "vendor_id",
        "llmVendorId",
        "llm_vendor_id",
        "id",
      ]),
      record,
    ) ?? (packageSpec
      ? providerAssetFromMarketplacePackageSpec(type, packageSpec, record)
      : undefined);
  }
  if (type === "theme") {
    return themeAsset(
      stringField(record, [
        "bundleId",
        "bundle_id",
        "themeBundleId",
        "theme_bundle_id",
        "id",
      ]),
      record,
    ) ?? (packageSpec
      ? assetFromMarketplacePackageSpec(type, packageSpec, record)
      : undefined);
  }
  return languagePackAsset(
    stringField(record, [
      "locale",
      "languageCode",
      "language_code",
      "language",
      "id",
    ]),
    record,
  ) ?? (packageSpec
    ? assetFromMarketplacePackageSpec(type, packageSpec, record)
    : undefined);
}

export function assetFromMarketplaceCatalogFields(
  pluginType: MarketplacePackageType | undefined,
  packageSpec: string,
  fields?: Record<string, unknown>,
): MarketplacePackageAsset | undefined {
  const type = normalizeAssetType(pluginType);
  if (!type) return undefined;

  const explicit = fields
    ? parseMarketplacePackageAsset(
        fields.packageAsset ?? fields.package_asset ?? fields.asset,
      )
    : undefined;
  if (explicit?.type === type) return explicit;

  if (fields) {
    if (type === "provider") {
      const fromFields = providerAsset(
        stringField(fields, [
          "providerId",
          "provider_id",
          "vendorId",
          "vendor_id",
          "llmVendorId",
          "llm_vendor_id",
        ]),
        fields,
      );
      if (fromFields) return fromFields;
    } else if (type === "theme") {
      const fromFields = themeAsset(
        stringField(fields, [
          "bundleId",
          "bundle_id",
          "themeBundleId",
          "theme_bundle_id",
        ]),
        fields,
      );
      if (fromFields) return fromFields;
    } else {
      const fromFields = languagePackAsset(
        stringField(fields, [
          "locale",
          "languageCode",
          "language_code",
          "language",
        ]),
        fields,
      );
      if (fromFields) return fromFields;
    }
  }

  if (type === "provider") {
    const fromPackageSpec = providerAssetFromMarketplacePackageSpec(
      pluginType,
      packageSpec,
      fields ?? {},
    );
    if (fromPackageSpec) return fromPackageSpec;
  }

  return assetFromMarketplacePackageSpec(pluginType, packageSpec, fields);
}
