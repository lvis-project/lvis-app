/**
 * #893 — THE four-tier host-secret access gate: "may this plugin read this
 * host-managed secret key?".
 *
 * ONE authority for both host APIs that ask the question:
 *   - `hostApi.getSecret(key)` — src/boot/steps/plugin-runtime/host-api-factory.ts
 *   - `hostApi.resolveApiKey({purpose, vendor})` — src/main/host-api/resolve-api-key.ts
 *
 * Tiers, in order:
 *   (1) own namespace   — `plugin.<pluginId>.*`. ADDITIVE WHITELIST: this tier
 *       intentionally never consults the whitelist registry, so a
 *       non-whitelisted plugin still gets to hold its own keys under its own
 *       namespace.
 *   (2) manifest allowlist — the key must appear verbatim in
 *       `manifest.hostSecrets.read[]`.
 *   (3) whitelist registry — `whitelistRegistry.isAllowed(pluginId, key,
 *       manifestSha256)`. A remote-signed policy roll can pull a grant without
 *       shipping a host build; the manifest-SHA pin stops a post-install
 *       manifest swap from inheriting the grant.
 *   (4) active-vendor cross-check — the vendor named by the key must be the
 *       user's ACTIVE provider, so a plugin cannot harvest idle credentials
 *       for a provider that is not in use.
 *
 * Tier-3 BEFORE Tier-4: the whitelist is a coarse, signed, statically-declared
 * ACL; the vendor cross-check is dynamic per-call state driven by
 * `settings.llm.provider`. Running the coarse ACL first keeps the dynamic
 * per-session vendor identity from leaking through the deny-reason channel of
 * an unwhitelisted plugin.
 *
 * WHAT STAYS AT THE CALL SITES, and why: audit-log lines, counter increments,
 * and the shape of the returned value. `getSecret` answers with `string | null`
 * for one named key; `resolveApiKey` answers with the SDK's discriminated union
 * plus a bearer/release lifetime. Those are wrappers around this decision, not
 * part of it. The `via` / `tier` / `reason` discriminators exist so each caller
 * can render its own audit vocabulary from ONE verdict — see `grantAuditSource`
 * in resolve-api-key.ts for the exhaustive-match pattern.
 *
 * Tiers 1 and 2 used to be hand-copied into both callers while only 3+4 were
 * shared. The copies drifted: `resolveApiKey` synthesized only
 * `llm.apiKey.<vendor>` and so had NO reachable allow path for a
 * marketplace-provider preset key, a family `getSecret`, the manifest schema,
 * and the signed whitelist schema all accept.
 */
import {
  isMarketplaceProviderPresetId,
  marketplaceProviderPresetSecretKey,
} from "../../shared/marketplace-package-assets.js";
import { whitelistRegistry } from "./whitelist-registry.js";

/** `llm.apiKey.<vendor>` — the per-vendor host-secret key family. */
const LLM_API_KEY_PREFIX = "llm.apiKey.";
/** `llm.marketplaceProvider.<presetId>.apiKey` — the preset key family. */
const MARKETPLACE_PROVIDER_KEY_PREFIX = "llm.marketplaceProvider.";
const MARKETPLACE_PROVIDER_KEY_SUFFIX = ".apiKey";
/** The host vendor id that routes through a marketplace provider preset. */
const OPENAI_COMPATIBLE = "openai-compatible";

/**
 * #958 round-1 security MEDIUM — `via` discriminator on the `allow` variant so
 * the audit trail can record WHICH gate path produced the grant:
 *   - `"own-namespace"`  — Tier-1; no host secret was read at all.
 *   - `"admin-bypass"`   — Tier-3 skipped because `installPolicy === "admin"`.
 *     The install-time manifest SHA pin and Tier-4 still ran.
 *   - `undefined`        — all four tiers ran and passed.
 *
 * Callers pattern-match exhaustively, so a new variant is a compile-time error
 * at every audit/counter site rather than a silently wrong audit line.
 */
export type SecretGateOutcome =
  | { kind: "allow"; via?: "admin-bypass" | "own-namespace" }
  | {
      kind: "deny";
      tier: "tier-2" | "tier-3" | "tier-4";
      reason:
        | "not-allowlisted"
        | "not-whitelisted"
        | "manifest-sha-mismatch"
        | "whitelist-unreachable"
        | "whitelist-stale-exceeded"
        | "vendor-mismatch";
    };

/**
 * The dynamic settings state Tier-4 compares against. Passed in rather than
 * read here so the gate stays free of the settings service and is trivially
 * exercisable from a test.
 */
export interface SecretGateSettings {
  /** `settings.llm.provider`. */
  readonly llmProvider: string;
  /** `settings.llm.marketplaceProviderPresetId`, unvalidated. */
  readonly marketplaceProviderPresetId: unknown;
  /**
   * `providerId` of every entry in `settings.marketplace.installedProviderPresets`.
   * A thunk because ONLY the marketplace-preset key family consults it — the
   * far more common `llm.apiKey.<vendor>` request never reads that settings
   * section at all.
   */
  readonly readInstalledProviderPresetIds: () => readonly string[];
}

export interface SecretGateInput {
  readonly pluginId: string;
  /** The host-secret key being requested, verbatim. */
  readonly key: string;
  /** `manifest.hostSecrets.read[]`. */
  readonly allowlist: readonly string[];
  readonly manifestSha256?: string;
  readonly installedManifestSha256?: string;
  /**
   * #955 follow-up — when the REGISTRY recorded `installSource: "admin"`, the
   * operator has explicitly accepted an elevated install grant and the separate
   * Tier-3 signed whitelist ACL is redundant. Admin mode still preserves the
   * install-time manifest SHA pin and Tier-4, so an elevated marketplace grant
   * cannot survive a plugin.json swap or read an idle provider's key.
   *
   * Must be derived from registry data, never from `manifest.installPolicy`:
   * plugin.json is inside the plugin's own writable surface.
   */
  readonly installPolicy?: "user" | "admin";
  /**
   * Read LAZILY — only Tier-4 needs it, so a Tier-1 or Tier-2 verdict costs no
   * settings reads. Callers hand in a thunk rather than a snapshot to keep that
   * property visible at the call site.
   */
  readonly readSettings: () => SecretGateSettings;
}

/**
 * Which host-secret key holds the credential for `vendor` — the one place that
 * answers "what should I ask the gate for?".
 *
 * When the user's active provider is a marketplace provider preset, the key is
 * the preset form; otherwise it is the per-vendor form. `resolveApiKey` takes a
 * vendor and needs the key; without this it could only ever name
 * `llm.apiKey.<vendor>`, which made the whole preset key family unreachable
 * through the lifetime-safe API.
 */
export function hostSecretKeyForVendor(
  vendor: string,
  settings: Pick<SecretGateSettings, "llmProvider" | "marketplaceProviderPresetId">,
): string {
  if (
    vendor === OPENAI_COMPATIBLE &&
    settings.llmProvider === OPENAI_COMPATIBLE &&
    isMarketplaceProviderPresetId(settings.marketplaceProviderPresetId)
  ) {
    return marketplaceProviderPresetSecretKey(settings.marketplaceProviderPresetId);
  }
  return `${LLM_API_KEY_PREFIX}${vendor}`;
}

/**
 * The `(vendor, activeProvider)` pair Tier-4 compares, derived from the
 * requested key. A key family the gate does not recognise compares equal to
 * itself, i.e. Tier-4 is a no-op for it — Tier-2/Tier-3 remain the gate.
 */
function vendorCrossCheck(
  key: string,
  settings: SecretGateSettings,
): { vendor: string; activeProvider: string } {
  if (key.startsWith(LLM_API_KEY_PREFIX)) {
    const vendor = key.slice(LLM_API_KEY_PREFIX.length);
    const activeProvider =
      vendor === OPENAI_COMPATIBLE &&
      settings.llmProvider === OPENAI_COMPATIBLE &&
      isMarketplaceProviderPresetId(settings.marketplaceProviderPresetId)
        ? settings.marketplaceProviderPresetId
        : settings.llmProvider;
    return { vendor, activeProvider };
  }
  const presetId = marketplaceProviderPresetIdFromKey(key);
  if (presetId.length > 0) {
    // A preset key only unlocks while its preset is BOTH installed and the
    // active provider; an uninstalled or inactive preset yields an empty
    // `activeProvider`, which can never equal a non-empty vendor.
    const installed =
      isMarketplaceProviderPresetId(presetId) &&
      settings.readInstalledProviderPresetIds().includes(presetId);
    const activeProvider =
      installed &&
      settings.llmProvider === OPENAI_COMPATIBLE &&
      settings.marketplaceProviderPresetId === presetId
        ? presetId
        : "";
    return { vendor: presetId, activeProvider };
  }
  return { vendor: "", activeProvider: "" };
}

/** Raw `<presetId>` segment of a preset key, or `""`. Deliberately untrimmed. */
function marketplaceProviderPresetIdFromKey(key: string): string {
  if (
    !key.startsWith(MARKETPLACE_PROVIDER_KEY_PREFIX) ||
    !key.endsWith(MARKETPLACE_PROVIDER_KEY_SUFFIX)
  ) {
    return "";
  }
  return key.slice(
    MARKETPLACE_PROVIDER_KEY_PREFIX.length,
    -MARKETPLACE_PROVIDER_KEY_SUFFIX.length,
  );
}

/**
 * Run all four tiers in their fixed order and return the first verdict.
 *
 * Callers MUST still emit their own audit lines + counter increments — the gate
 * deliberately stays free of those so it can serve both the boot-context
 * `getSecret` (which logs through `bootAuditLogger`) and the per-plugin
 * `resolveApiKey` (which logs through an injected `auditLogger`).
 */
export function runSecretGate(input: SecretGateInput): SecretGateOutcome {
  // Tier 1 — own namespace.
  if (input.key.startsWith(`plugin.${input.pluginId}.`)) {
    return { kind: "allow", via: "own-namespace" };
  }
  // Tier 2 — manifest allowlist.
  if (!input.allowlist.includes(input.key)) {
    return { kind: "deny", tier: "tier-2", reason: "not-allowlisted" };
  }
  const { vendor, activeProvider } = vendorCrossCheck(input.key, input.readSettings());
  // Tier 3 — signed whitelist registry (skipped only for admin installs).
  if (input.installPolicy === "admin") {
    if (
      !input.manifestSha256 ||
      !input.installedManifestSha256 ||
      input.manifestSha256.toLowerCase() !== input.installedManifestSha256.toLowerCase()
    ) {
      return { kind: "deny", tier: "tier-3", reason: "manifest-sha-mismatch" };
    }
    if (vendor !== activeProvider) {
      return { kind: "deny", tier: "tier-4", reason: "vendor-mismatch" };
    }
    return { kind: "allow", via: "admin-bypass" };
  }
  const decision = whitelistRegistry.isAllowed(
    input.pluginId,
    input.key,
    input.manifestSha256,
  );
  if (decision.kind === "deny") {
    return { kind: "deny", tier: "tier-3", reason: decision.reason };
  }
  // Tier 4 — active-vendor cross-check.
  if (vendor !== activeProvider) {
    return { kind: "deny", tier: "tier-4", reason: "vendor-mismatch" };
  }
  return { kind: "allow" };
}
