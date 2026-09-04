import type { MarketplacePackageType } from "../shared/assistant-context.js";
import type { MarketplacePackageAsset } from "../shared/marketplace-package-assets.js";
import type {
  DependencySpec,
  InstallPolicy,
  McpAuthMetadata,
  McpRuntimeSpec,
  PluginAccessSpec,
  PluginAuthSpec,
  PluginManifest,
  RequiresSpec,
} from "./public-contract.js";

export * from "./public-contract.js";

/**
 * Host-private persistence and marketplace DTOs. These are intentionally kept
 * outside `public-contract.ts` so they cannot enter the generated SDK surface.
 */

export type PluginRegistryEntryInstallSource = "admin" | "user" | "local-dev";

export interface PluginRegistryEntry {
  id: string;
  manifestPath: string;
  /**
   * Canonical JSON SHA-256 of plugin.json recorded at install time. Runtime
   * HostApi gates compare the running manifest against this host-owned value
   * before honoring admin secret-access bypasses.
   */
  manifestSha256?: string;
  enabled?: boolean;
  bundleRefs?: string[];
  approvedPluginAccess?: PluginAccessSpec;
  installSource?: PluginRegistryEntryInstallSource;
  /** Durable replacement marker; runtime discovery skips marked rows. */
  pendingUpdate?: {
    kind: "marketplace" | "local-dev";
    previousManifestFileSha256: string | null;
    previousReceiptRaw: string | null;
    recoveryBackupDir?: string;
    recoveryBackupMode?: "rename" | "copy";
  };
  /** Durable ownership journal for obsolete, never-restorable directories. */
  pendingCleanup?: Array<{
    kind: "obsolete-artifact" | "obsolete-local-backup";
    path: string;
  }>;
}

export interface PluginRegistry {
  version: number;
  plugins: PluginRegistryEntry[];
}

export interface PluginMarketplaceItem {
  id: string;
  /** Web marketplace slug — used when installing via lvis:// URI from the web catalog. */
  slug?: string;
  name: string;
  description: string;
  packageSpec: string;
  packageName: string;
  /** Latest stable version string (semver). Present in remote catalog; may be absent in local mock. */
  version?: string;
  /** SHA-256 of the latest stable marketplace artifact. Used to invalidate stale same-version cache entries. */
  artifactSha256?: string;
  /**
   * `version → SHA-256` for every version the catalog lists, when the response
   * carried them.
   *
   * `artifactSha256` above covers only the latest, so an explicit prior-version
   * install — a rollback, or a pinned `installPlugin` — had nothing to compare
   * the downloaded bytes against and fell back to the signature alone. The
   * signature binds the BYTES but not which plugin or version they belong to,
   * so that path could not tell a correct artifact from a different valid one
   * served in its place.
   *
   * Optional because a catalog response may omit the version list; absence
   * must not be read as "no hash to check" for a version that IS listed.
   */
  artifactSha256ByVersion?: Readonly<Record<string, string>>;
  /** S8 — release channel. "stable" (default) or "canary". */
  channel?: "stable" | "canary";
  /**
   * Catalog-declared capabilities, kept as the trusted "expected" side of the
   * install-time integrity cross-check in `assertInstalledManifestMatchesCatalog`
   * (the runtime-enforced capability TOCTOU guard). This maps only the catalog's
   * top-level `capabilities`; `requires.capabilities` is a distinct dependency
   * contract and must never grant artifact capabilities. An omitted or malformed
   * catalog field therefore remains the conservative empty set — a tampered zip
   * cannot silently gain a runtime-enforced capability beyond what the catalog advertises.
   */
  capabilities?: string[];
  auth?: PluginAuthSpec;
  networkAccess?: PluginManifest["networkAccess"];
  installPolicy?: InstallPolicy;
  dependencies?: Array<string | DependencySpec>;
  pluginAccess?: PluginAccessSpec;
  publisher?: string;
  /** S14: dependency capabilities this plugin requires. */
  requires?: RequiresSpec;
  /**
   * Catalog package kind. Defaults to `"plugin"` when the server omits the
   * field (back-compat with pre-#52 catalogs). Asset entries are discoverable
   * before their installers are enabled.
   *
   * Absent alongside {@link unsupportedPackageKind}, which is the opposite
   * case; read the pair through `marketplacePackageTypeOf` rather than
   * defaulting this field at each call site.
   */
  pluginType?: MarketplacePackageType;
  /**
   * The kind the catalog declared when this build does not recognise it.
   *
   * The catalog is an external boundary and it grows kinds this app has never
   * heard of. Such a row is carried so it can be SHOWN — named, with the update
   * affordance — and never treated as a plugin, which is what the fetcher's
   * former coercion did: it offered an install that could only fail.
   */
  unsupportedPackageKind?: string;
  /** Structured target for an asset marketplace package. */
  packageAsset?: MarketplacePackageAsset;
  /**
   * Display-only compatibility result for an app that must update before this
   * package can be installed. This must never carry install metadata.
   */
  upgradeRequired?: {
    code: "upgrade_required";
    /** Omitted only when Marketplace cannot provide a trusted exact minimum. */
    minAppVersion?: string;
    message: string;
  };
  /**
   * MCP runtime block — present when `pluginType === "mcp"` and the
   * server has the schema extension. The host materializes this into
   * the user's mcp-servers.json after install. The authoritative copy
   * always lives in the extracted manifest's `runtime` field; the
   * catalog row may carry a duplicate as advisory metadata.
   */
  mcpRuntime?: McpRuntimeSpec;
  /** Safe login metadata surfaced by lvis-marketplace for MCP entries. */
  mcpAuth?: McpAuthMetadata;
}

/**
 * A signed registry document after envelope verification, together with where
 * it was read from. The whitelist, admission and revocation registries all
 * cache exactly this pair.
 */
export interface ResolvedSignedSnapshot<Doc, Source extends string> {
  doc: Doc;
  source: Source;
}
