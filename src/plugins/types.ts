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
   * field (back-compat with pre-#52 catalogs). Provider/theme/language-pack
   * entries are discoverable before their installers are enabled.
   */
  pluginType?: MarketplacePackageType;
  /** Structured target for provider/theme/language-pack marketplace packages. */
  packageAsset?: MarketplacePackageAsset;
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
