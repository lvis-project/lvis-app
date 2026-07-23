import { cp, mkdir, readFile, rename, rm, stat as statAsync } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { buildSideloadCopyFilter, rejectEscapingSymlinks } from "./sideload-filter.js";
import { readPluginRegistry, updatePluginRegistry } from "./registry.js";
import type { PluginDeploymentGuard } from "./deployment-guard.js";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import { toRegistryRelativeManifestPath, type PluginPaths } from "./plugin-paths.js";
import { assertMockMarketplaceAllowed, isDevModeUnlocked } from "../boot/dev-flags.js";
import type { PluginAccessSpec, PluginManifest, PluginMarketplaceItem, PluginRegistryEntryInstallSource } from "./types.js";
import { IncompatibleAppVersionError, MissingDependenciesError, MissingPluginDependenciesError } from "./types.js";
import { appVersionSatisfiesMin } from "../shared/semver-compare.js";
import { getLvisAppVersion } from "../shared/app-version.js";
import { resolveDependencies } from "./dependency-resolver.js";
import { isNewer } from "./update-detector.js";
import { getCachedCatalog, isOfflineCacheEnabled, setCachedCatalog } from "./offline-cache.js";
import type { InstallerProgressEvent } from "./marketplace-installer.js";
import { getBundledPublicKeys } from "./publisher-keys.js";
import { ArtifactRollbackError, PluginArtifactStore, retryOnTransientFsLock } from "./plugin-artifact-store.js";
import { assertSafeArtifactSlug } from "./plugin-id.js";
import {
  cleanupPendingPluginUpdateBackup,
  cleanupObsoletePluginBackup,
  cleanupObsoletePluginBackupPath,
  clearObsoletePluginBackupOwnership,
  pendingOwnedBackupPaths,
  preparePendingPluginUpdate,
  recoverPendingPluginUpdate,
  recoverPendingPluginUpdates,
  restoreSupersededPendingPluginUpdate,
} from "./marketplace-update-recovery.js";
import { installReceiptPath, listFilesRecursive, restoreInstallReceiptRaw, verifyInstallReceipt } from "./plugin-install-receipt.js";
import { canonicalJSON } from "./whitelist/canonical-json.js";
import {
  abortRemovalTransaction,
  assertCanonicalRegistryOwnership,
  createRemovalTransaction,
  finishRemovalTransaction,
  markRemovalTransactionRegistryCommitted,
  stageRemovalTransaction,
  type RemovalTransactionKind,
} from "./plugin-removal-transaction.js";
import type { PluginInstallReceipt } from "./plugin-install-receipt.js";
import { STABLE_SEMVER_RE } from "./runtime/manifest-validation.js";
import { KNOWN_CAPABILITY_IDS } from "./capabilities.js";
import type { InstallPolicy, PluginRegistryEntry } from "./types.js";
import type { PluginInstallFailureKind } from "../shared/plugin-install-failure.js";
import { createLogger } from "../lib/logger.js";
import { readAgentRegistry } from "../agents/agent-registry.js";
import { readSkillRegistry } from "../skills/skill-registry.js";
import { lvisHome } from "../shared/lvis-home.js";
import {
  buildNetworkAccessAcknowledgement,
  networkAccessGrantsEqual,
  type NetworkAccessAcknowledgement,
} from "../shared/network-access.js";
import type { AuditLogger } from "../audit/audit-logger.js";
const log = createLogger("marketplace");

import {
  isMarketplaceAnnouncementLevel,
  type MarketplaceAnnouncement,
} from "../shared/marketplace-announcements.js";
export type { MarketplaceAnnouncement, MarketplaceFetcher } from "./marketplace-fetcher.js";

export interface MarketplaceInstallFailureDiagnostic {
  id: string;
  name: string;
  description: string;
  error: string;
  installFailureKind?: PluginInstallFailureKind;
  isManaged: boolean;
  installPolicy: InstallPolicy;
  installAliases: string[];
  networkAccess?: PluginMarketplaceItem["networkAccess"];
  version?: string;
  publisher?: string;
}

function normalizeInstallPolicy(source: {
  installPolicy?: InstallPolicy;
}): InstallPolicy {
  if (source.installPolicy === "admin") {
    return "admin";
  }
  return "user";
}

function normalizePluginLookupKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/@[^/@]+$/, "")
    .replace(/^lvis-plugin-/, "")
    .replace(/^plugin-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function catalogItemMatchesPluginId(item: PluginMarketplaceItem, pluginId: string): boolean {
  const pluginKey = normalizePluginLookupKey(pluginId);
  return [item.id, item.slug, item.name, item.packageName, item.packageSpec].some((value) =>
    normalizePluginLookupKey(value) === pluginKey,
  );
}

function shaOfManifest(manifest: unknown): string {
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}

/**
 * #1098 — content fingerprint of the catalog item that drove an install's
 * escalation decision. Recorded in the escalation audit so forensics can pin
 * the EXACT catalog snapshot used (policy + version + metadata), and the whole
 * install transaction reads from one in-memory snapshot rather than re-fetching
 * the catalog between the policy decision and the artifact install (TOCTOU).
 */
function shaOfCatalogItem(item: PluginMarketplaceItem): string {
  return createHash("sha256").update(canonicalJSON(item)).digest("hex");
}

function findRuntimeCapabilityMismatches(
  expected: { capabilities?: readonly string[] },
  actual: { capabilities?: readonly string[] },
): string[] {
  const expectedCapabilities = new Set(expected.capabilities ?? []);
  const actualCapabilities = new Set(actual.capabilities ?? []);
  return KNOWN_CAPABILITY_IDS.filter(
    (capability) => expectedCapabilities.has(capability) !== actualCapabilities.has(capability),
  );
}

function classifyInstallFailure(message: string): PluginInstallFailureKind | undefined {
  if (message.includes("schema validation failed") || message.includes("manifest validation")) {
    return "manifest-validation-error";
  }
  if (message.includes("artifact manifest") && message.includes("catalog-approved grant")) {
    return "catalog-grant-mismatch";
  }
  // IncompatibleAppVersionError — "plugin requires LVIS >= x, current y". A
  // reinstall re-fetches the same too-new package and re-throws, so the Doctor
  // must fall back to a diagnosis (update the app) rather than loop on a
  // reinstall that cannot succeed.
  if (message.includes("plugin requires LVIS >=")) {
    return "incompatible-app-version";
  }
  return undefined;
}

function assertNetworkAccessAcknowledgement(options: {
  plugin: PluginMarketplaceItem;
  acknowledgement?: NetworkAccessAcknowledgement;
}): void {
  const expected = buildNetworkAccessAcknowledgement(options.plugin.networkAccess);
  if (!expected) return;
  if (JSON.stringify(options.acknowledgement ?? null) === JSON.stringify(expected)) return;
  throw new Error(
    `plugin "${options.plugin.id}" networkAccess grant must be acknowledged before install`,
  );
}

function resolveRollbackInstallSource(
  currentSource: PluginRegistryEntryInstallSource | undefined,
  snapshotSource: PluginRegistryEntryInstallSource | undefined,
): PluginRegistryEntryInstallSource {
  if (snapshotSource === "admin" || currentSource === "admin") return "admin";
  return "user";
}

function normalizeDependencies(
  plugin: Pick<PluginMarketplaceItem, "dependencies">,
): Array<{ pluginId: string; versionRange?: string; required: boolean }> {
  const result: Array<{ pluginId: string; versionRange?: string; required: boolean }> = [];
  for (const dependency of plugin.dependencies ?? []) {
    if (typeof dependency === "string") {
      result.push({ pluginId: dependency, required: true });
      continue;
    }
    if (!dependency?.pluginId) continue;
    result.push({
      pluginId: dependency.pluginId,
      versionRange: dependency.versionRange,
      required: dependency.required ?? true,
    });
  }
  return result;
}

type MarketplaceCatalog = {
  version: number;
  plugins: PluginMarketplaceItem[];
  /** Optional dev/test announcement fixtures (mirrors GET /api/v1/announcements). */
  announcements?: MarketplaceAnnouncement[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMarketplaceAnnouncement(value: unknown): value is MarketplaceAnnouncement {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    isMarketplaceAnnouncementLevel(value.level) &&
    typeof value.createdAt === "string" &&
    (value.startsAt === null || typeof value.startsAt === "string") &&
    (value.endsAt === null || typeof value.endsAt === "string")
  );
}

function assertMarketplaceAnnouncements(
  value: unknown,
  marketplacePath: string,
): MarketplaceAnnouncement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Invalid marketplace catalog announcements: ${marketplacePath}`);
  }
  for (const [index, announcement] of value.entries()) {
    if (!isMarketplaceAnnouncement(announcement)) {
      throw new Error(
        `Invalid marketplace catalog announcement at index ${index}: ${marketplacePath}`,
      );
    }
  }
  return value as MarketplaceAnnouncement[];
}

type InstallOperationState = {
  installedPluginIds: string[];
  touchedEntries: Map<
    string,
    {
      enabled: boolean | undefined;
      bundleRefs: string[] | undefined;
      approvedPluginAccess: PluginRegistryEntry["approvedPluginAccess"];
      installSource: PluginRegistryEntryInstallSource | undefined;
      manifestSha256: string | undefined;
      pendingUpdate: PluginRegistryEntry["pendingUpdate"];
      pendingCleanup: PluginRegistryEntry["pendingCleanup"];
    }
  >;
};

type LocalInstallRollbackSnapshot = {
  kind: "filesystem-snapshot" | "pending-predecessor";
  installDir: string;
  backupDir?: string;
  receiptRaw?: string;
  registryEntry: PluginRegistryEntry;
};

type InstallReceiptValidation = {
  ok: boolean;
  reason?: string;
  receipt?: PluginInstallReceipt;
};

function cleanupJournalAfterCommit(entry: PluginRegistryEntry): PluginRegistryEntry["pendingCleanup"] {
  const journal = (entry.pendingCleanup ?? []).map((item) => ({ ...item, path: resolve(item.path) }));
  const pending = entry.pendingUpdate;
  if (pending?.recoveryBackupDir && pending.recoveryBackupMode) {
    const item = {
      kind: pending.recoveryBackupMode === "rename"
        ? "obsolete-artifact" as const
        : "obsolete-local-backup" as const,
      path: resolve(pending.recoveryBackupDir),
    };
    if (!journal.some((candidate) => candidate.path === item.path)) journal.push(item);
  }
  return journal.length > 0 ? journal : undefined;
}

export interface MarketplaceListItem extends PluginMarketplaceItem {
  installed: boolean;
  enabled: boolean;
  /** §9.6: true if protected (managed) — used by UI to show lock icon */
  isManaged: boolean;
}

/**
 * Disabled fetcher — used when no real-cloud backend is configured in a
 * packaged build. Constructor is side-effect free so boot does not crash;
 * any actual marketplace method (list/install/download) throws a clear
 * `marketplace-disabled` error so callers can degrade gracefully. The
 * managed bootstrap (`resolveManagedPluginBootstrap`) short-circuits
 * before reaching this fetcher in the same conditions.
 */
export class DisabledMarketplaceFetcher implements MarketplaceFetcher {
  private static readonly ERR =
    "marketplace-disabled: no marketplace backend configured for this build";

  async listPlugins(): Promise<PluginMarketplaceItem[]> {
    throw new Error(DisabledMarketplaceFetcher.ERR);
  }

  async getPluginDetail(): Promise<PluginMarketplaceItem | null> {
    throw new Error(DisabledMarketplaceFetcher.ERR);
  }

  async downloadVersion(): Promise<{ zipBuffer: Buffer; sha256: string }> {
    throw new Error(DisabledMarketplaceFetcher.ERR);
  }

  async listAnnouncements(): Promise<MarketplaceAnnouncement[]> {
    throw new Error(DisabledMarketplaceFetcher.ERR);
  }
}

/**
 * @internal Dev/test-only fetcher. Reads a local JSON catalog file.
 *
 * Production / packaged builds MUST use {@link CloudMarketplaceFetcher}
 * — the constructor throws when invoked in a packaged build via the shared
 * dev-flags gate. The local `plugins/marketplace.json` is user-writable and
 * cannot serve as a trust anchor; any packaged binary that fell back to this
 * fetcher would let local users advertise their own plugins as
 * `installPolicy:"admin"` and get them auto-installed by the managed
 * bootstrap (security review: mock fetcher must not run in packaged builds).
 *
 * Note: downloadVersion() is not supported regardless of build mode.
 */
export class MockMarketplaceFetcher implements MarketplaceFetcher {
  constructor(private readonly marketplacePath: string) {
    assertMockMarketplaceAllowed();
  }

  async listPlugins(): Promise<PluginMarketplaceItem[]> {
    const catalog = await this.readCatalog();
    return catalog.plugins;
  }

  async getPluginDetail(slug: string): Promise<PluginMarketplaceItem | null> {
    const catalog = await this.readCatalog();
    return catalog.plugins.find((p) => p.id === slug) ?? null;
  }

  async downloadVersion(
    _slug: string,
    _version: string,
  ): Promise<{ zipBuffer: Buffer; sha256: string }> {
    throw new Error(
      "MockMarketplaceFetcher does not support downloadVersion(); use CloudMarketplaceFetcher",
    );
  }

  async listAnnouncements(): Promise<MarketplaceAnnouncement[]> {
    const catalog = await this.readCatalog();
    return catalog.announcements ?? [];
  }

  async readCatalog(): Promise<MarketplaceCatalog> {
    const raw = await readFile(this.marketplacePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
      throw new Error(`Invalid marketplace catalog: ${this.marketplacePath}`);
    }
    const announcements = assertMarketplaceAnnouncements(
      parsed.announcements,
      this.marketplacePath,
    );
    return {
      ...(parsed as Omit<MarketplaceCatalog, "announcements">),
      announcements,
    };
  }
}

export class PluginMarketplaceService {
  private readonly paths: PluginPaths;
  private readonly registryPath: string;
  private readonly pluginsRoot: string;
  private readonly deploymentGuard?: PluginDeploymentGuard;
  private readonly fetcher: MarketplaceFetcher;
  /**
   * Optional audit sink — wired by boot so `install()` can emit the
   * per-plugin admin escalation entry from the same trust boundary that
   * owns the catalog fetch. IPC handler stays a pure transport.
   */
  private readonly auditLogger?: AuditLogger;
  /** §9.6: per-plugin version cache for rollback. */
  private readonly cacheRoot: string;
  /**
   * §FU#267 — artifact-management subsystem. Owns signed-zip
   * download, atomic extract, history journal, version snapshot cache.
   * The orchestrator (this class) coordinates registry writes around it.
   */
  private readonly artifactStore: PluginArtifactStore;
  /**
   * S9: base directory for the catalog cache. `null` disables catalog caching
   * (test mock fetcher). Defaults to `paths.cacheRoot/marketplace-catalog`
   * so the SoT stays inside the plugin tree (`~/.lvis/plugins/.cache/`).
   */
  private readonly catalogCacheBase: string | null;
  /**
   * Per-plugin in-process mutex. Concurrent install/rollback
   * calls for the same pluginId are serialized to protect the cache
   * breadcrumb + history.json from corruption.
   */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly installReceiptValidationCache = new Map<string, InstallReceiptValidation>();
  private readonly localInstallRollbackSnapshots = new Map<string, LocalInstallRollbackSnapshot>();
  private readonly installFailureDiagnostics = new Map<string, MarketplaceInstallFailureDiagnostic>();
  /** Optional diagnostic logger. Injected in tests; no-op in production. */
  readonly log?: (message: string, ...args: unknown[]) => void;

  /**
   * Constructor — `paths` is the single source of truth for
   * the registry / installed-dir / cache layout, and `fetcher` is required.
   * The `appRoot` argument used by the former npm-install branch is
   * gone; the only install path is the signed-zip download under
   * `paths.pluginsRoot`.
   */
  constructor(
    paths: PluginPaths,
    fetcher: MarketplaceFetcher,
    deploymentGuard?: PluginDeploymentGuard,
    auditLogger?: AuditLogger,
  ) {
    this.paths = paths;
    this.registryPath = paths.registryPath;
    this.pluginsRoot = paths.pluginsRoot;
    this.cacheRoot = paths.cacheRoot;
    this.deploymentGuard = deploymentGuard;
    this.fetcher = fetcher;
    this.auditLogger = auditLogger;
    // Catalog cache is off for the test mock fetcher; production fetchers
    // get a sibling under `paths.cacheRoot` (closed #266 — was homedir()).
    this.catalogCacheBase =
      fetcher instanceof MockMarketplaceFetcher
        ? null
        : resolve(paths.cacheRoot, "marketplace-catalog");
    // Artifact store owns the same `pluginsRoot` (extract target) +
    // `cacheRoot` (history + version snapshots). Tarball offline cache
    // also lives under `cacheRoot`, not homedir().
    this.artifactStore = new PluginArtifactStore({
      installRoot: paths.pluginsRoot,
      cacheRoot: paths.cacheRoot,
      fetcher,
      publicKeys: getBundledPublicKeys(),
      tarballCacheBase: fetcher instanceof MockMarketplaceFetcher ? null : undefined,
    });
  }

  /**
   * #FU259 accessor — the MCP install IPC needs the same fetcher to
   * resolve catalog detail by slug before driving the artifact store.
   * Read-only escape hatch; callers must not mutate fetcher state.
   */
  getFetcher(): MarketplaceFetcher {
    return this.fetcher;
  }

  getInstallFailureDiagnostics(): MarketplaceInstallFailureDiagnostic[] {
    return [...this.installFailureDiagnostics.values()];
  }

  clearInstallFailureDiagnostic(pluginId: string): boolean {
    return this.installFailureDiagnostics.delete(pluginId);
  }

  private rememberInstallFailure(plugin: PluginMarketplaceItem, error: unknown): void {
    const installPolicy = normalizeInstallPolicy(plugin);
    const message = error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
    const installFailureKind = classifyInstallFailure(message);
    const installAliases = [plugin.slug, plugin.packageName, plugin.packageSpec]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    this.installFailureDiagnostics.set(plugin.id, {
      id: plugin.id,
      name: plugin.name || plugin.id,
      description: plugin.description || plugin.name || plugin.id,
      error: message,
      ...(installFailureKind ? { installFailureKind } : {}),
      isManaged: installPolicy === "admin",
      installPolicy,
      installAliases,
      ...(plugin.networkAccess ? { networkAccess: plugin.networkAccess } : {}),
      ...(plugin.version ? { version: plugin.version } : {}),
      ...(plugin.publisher ? { publisher: plugin.publisher } : {}),
    });
  }

  private clearInstallFailure(pluginId: string): void {
    this.installFailureDiagnostics.delete(pluginId);
  }

  async list(): Promise<MarketplaceListItem[]> {
    // Catalog cache is null when using the test mock fetcher; production
    // always has a cache base under `~/.lvis/plugins/.cache/` (set in
    // constructor).
    const cacheBase = this.catalogCacheBase;
    const useCache = cacheBase !== null && isOfflineCacheEnabled();
    let catalogPlugins: PluginMarketplaceItem[] | null = null;

    if (useCache) {
      catalogPlugins = await getCachedCatalog(cacheBase);
    }

    let fetchedFromNetwork = false;
    if (!catalogPlugins) {
      try {
        catalogPlugins = await this.fetcher.listPlugins();
        fetchedFromNetwork = true;
      } catch (err) {
        // Network failure — fall back to stale cache if available (TTL bypassed
        // intentionally: any cached data is better than a hard failure offline).
        const stale = useCache ? await getCachedCatalog(cacheBase, { allowStale: true }) : null;
        if (stale) {
          log.warn("network fetch failed, using stale cache: %s", (err as Error).message);
          catalogPlugins = stale;
        } else {
          throw err;
        }
      }
    }

    if (fetchedFromNetwork && useCache) {
      await setCachedCatalog(catalogPlugins, cacheBase);
    }

    const [plugins, registry, agentRegistry, skillRegistry] = await Promise.all([
      Promise.resolve(catalogPlugins),
      readPluginRegistry(this.registryPath),
      readAgentRegistry(resolve(lvisHome(), "agents", "registry.json")),
      readSkillRegistry(resolve(lvisHome(), "skills", "registry.json")),
    ]);
    const items: MarketplaceListItem[] = [];
    for (const plugin of plugins) {
      const packageType = plugin.pluginType ?? "plugin";
      const entry = packageType === "plugin" || packageType === "mcp"
        ? registry.plugins.find((x) => x.id === plugin.id && !x.pendingUpdate)
        : undefined;
      const agentEntry = packageType === "agent"
        ? agentRegistry.agents.find((x) => x.id === plugin.id || x.id === plugin.slug)
        : undefined;
      const skillEntry = packageType === "skill"
        ? skillRegistry.skills.find((x) => x.id === plugin.id || x.id === plugin.slug)
        : undefined;
      const installed = packageType === "agent"
        ? !!agentEntry
        : packageType === "skill"
          ? !!skillEntry
          : packageType === "plugin" || packageType === "mcp"
            ? !!entry
            : false;
      const enabled = packageType === "agent"
        ? agentEntry?.enabled !== false
        : packageType === "skill"
          ? skillEntry?.enabled !== false
          : packageType === "plugin" || packageType === "mcp"
            ? entry?.enabled !== false
            : false;
      const isManaged = packageType === "agent" || packageType === "skill"
        ? false
        : packageType === "plugin" || packageType === "mcp"
          ? await this.resolveIsManaged(plugin, entry?.manifestPath)
          : false;
      items.push({
        ...plugin,
        installed,
        enabled,
        isManaged,
      });
    }
    return items;
  }

  private async resolveIsManaged(
    catalogItem: PluginMarketplaceItem,
    installedManifestPath?: string,
  ): Promise<boolean> {
    if (normalizeInstallPolicy(catalogItem) === "admin") return true;
    if (!installedManifestPath) return false;
    const abs = isAbsolute(installedManifestPath)
      ? installedManifestPath
      : resolve(dirname(this.registryPath), installedManifestPath);
    try {
      const raw = await readFile(abs, "utf-8");
      const parsed = JSON.parse(raw) as { installPolicy?: InstallPolicy };
      return normalizeInstallPolicy(parsed) === "admin";
    } catch {
      return false;
    }
  }

  /**
   * External install entry point — IPC + deep-link callers only pass a
   * pluginId (and an optional progress sink). Actor resolution lives
   * *inside* marketplace so the IPC handler stays a pure transport and the
   * deployment-guard §7.3 trust-boundary contract holds:
   *
   *   > IPC 핸들러에서 actor를 직접 받지 말 것 — "it-admin"은 ManagedPluginInstaller
   *   > 같은 내부 플로우에서만 사용.
   *
   * Catalog 의 installPolicy === "admin" 인 plugin (예: meeting v0.4.14+,
   * local-indexer v0.4.11+) 의 사용자 update click 시 actor 를 "it-admin"
   * 으로 자동 escalate. catalog 가 signed marketplace truth 이므로 boot-time
   * `ensureManagedInstalled` 의 actor="it-admin" 패턴과 동일 anchor.
   * catalog fetch 실패 시 default "user" — install path 의 deployment-guard
   * 가 다시 차단.
   */
  async install(
    pluginId: string,
    onProgress?: (event: InstallerProgressEvent) => void,
    options?: { networkAccessAcknowledgement?: NetworkAccessAcknowledgement },
  ): Promise<{ pluginId: string; installed: true }> {
    // #1098 — capture ONE catalog snapshot and use it for the whole install:
    // the escalation decision, the deployment guard, and the artifact select.
    // Previously the escalation read `getPluginDetail` while the guard/install
    // re-fetched `listPlugins`, leaving a TOCTOU window where the policy that
    // drove escalation could differ from the policy/artifact actually installed.
    //
    // The snapshot is now REQUIRED for the whole install (not just an optional
    // policy lookup), so a fetch failure is fatal — let the original error
    // propagate instead of swallowing it and masking it as "Plugin not found".
    const catalogSnapshot = await this.fetcher.listPlugins();
    let actor: "user" | "it-admin" = "user";
    const catalogItem = catalogSnapshot.find(
      (x) => x.id === pluginId || x.slug === pluginId,
    );
    if (catalogItem) {
      assertNetworkAccessAcknowledgement({
        plugin: catalogItem,
        acknowledgement: options?.networkAccessAcknowledgement,
      });
    }
    if (catalogItem && normalizeInstallPolicy(catalogItem) === "admin") {
      actor = "it-admin";
      try {
        // Record the canonical catalog `id` (not the caller-supplied id/slug)
        // so the audit row correlates with what the registry ultimately stores.
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: "marketplace-install",
          type: "info",
          input: `plugin-install-escalation: ${catalogItem.id} (user→it-admin, catalog installPolicy=admin)`,
          pluginInstall: {
            event: "plugin-install-escalation",
            pluginId: catalogItem.id,
            catalogPolicy: "admin",
            actorOriginal: "user",
            actorEscalated: "it-admin",
            location: "marketplace.install",
            catalogSnapshotHash: shaOfCatalogItem(catalogItem),
          },
        });
      } catch {
        // Audit failure must never block install.
      }
    }
    const canonicalPluginId = catalogItem?.id ?? pluginId;
    return this.withPluginLock(canonicalPluginId, async () => {
      const state: InstallOperationState = {
        installedPluginIds: [],
        touchedEntries: new Map(),
      };
      try {
        const result = await this.installWithDependencies(canonicalPluginId, actor, catalogSnapshot, new Set<string>(), state, onProgress);
        this.clearInstallFailure(result.pluginId);
        return result;
      } catch (error) {
        if (catalogItem) this.rememberInstallFailure(catalogItem, error);
        try {
          await this.rollbackInstallOperation(state);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `plugin install and rollback both failed: ${canonicalPluginId}`,
          );
        }
        throw error;
      }
    });
  }

  /**
   * @param catalogSnapshot the single catalog snapshot captured by the caller
   *   (#1098). The guard check and artifact selection read from THIS snapshot
   *   instead of re-fetching, so the policy that drove escalation is the same
   *   policy/artifact that gets installed.
   */
  private async installWithDependencies(
    pluginId: string,
    actor: "user" | "it-admin",
    catalogSnapshot: PluginMarketplaceItem[],
    seen: Set<string>,
    state: InstallOperationState,
    onProgress?: (event: InstallerProgressEvent) => void,
  ): Promise<{ pluginId: string; installed: true }> {
    const plugin = catalogSnapshot.find((x) => x.id === pluginId || x.slug === pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found in marketplace: ${pluginId}`);
    }
    const canonicalPluginId = plugin.id;
    if (seen.has(canonicalPluginId)) {
      return { pluginId: canonicalPluginId, installed: true };
    }
    seen.add(canonicalPluginId);
    if ((plugin.pluginType ?? "plugin") !== "plugin") {
      throw new Error(
        `Marketplace package "${canonicalPluginId}" is a ${plugin.pluginType} entry, not a plugin package`,
      );
    }

    // §7.2 canInstall — admin-policy catalog entries block user actor installs.
    // Boot-time force-install uses actor="it-admin" to bypass this guard for
    // mandatory enterprise plugins (see ensureManagedInstalled).
    if (this.deploymentGuard) {
      const guardResult = await this.deploymentGuard.canInstall(
        canonicalPluginId,
        actor,
        plugin.installPolicy,
      );
      if (!guardResult.allowed) {
        throw new Error(guardResult.reason ?? `Plugin install denied: ${canonicalPluginId}`);
      }
    }

    // Lazy-cached registry snapshot — shared by the plugin-id preflight
    // (issue #92) and the S14 capability preflight below. Avoids walking
    // the installed-manifests list twice when both branches fire.
    let installedManifestsCache: PluginManifest[] | null = null;
    const getInstalledManifests = async (): Promise<PluginManifest[]> => {
      if (installedManifestsCache === null) {
        installedManifestsCache = await this.loadInstalledManifests();
      }
      return installedManifestsCache;
    };

    // Issue #92 — plugin-id dependencies declared via `dependencies[]` are
    // NOT auto-installed. Soft (`required: false` or unset) dependencies are
    // informational only — the consumer plugin must degrade its feature
    // surface at runtime when a soft dependency is absent. Hard
    // (`required: true`, including the legacy string-form `"<id>"` which
    // `normalizeDependencies` coerces to `required: true`) dependencies must
    // already be installed by the time the consumer plugin is installed;
    // missing ones surface a clear error to the user instead of silently
    // cascading admin-policy failures.
    const deps = normalizeDependencies(plugin);
    if (deps.length > 0) {
      const installedIds = new Set((await getInstalledManifests()).map((m) => m.id));
      const missingRequired = deps
        .filter((d) => d.required && !installedIds.has(d.pluginId))
        .map((d) => d.pluginId);
      if (missingRequired.length > 0) {
        throw new MissingPluginDependenciesError(missingRequired);
      }
    }

    const existingEntry = await this.getRawRegistryEntry(canonicalPluginId);
    if (existingEntry) {
      // Same-version installs are idempotent only when the install receipt is
      // valid and the installed artifact hash still matches the catalog.
      // Otherwise reinstall so cache residue cannot mask a repaired artifact.
      const installedVersion = await this.getInstalledVersion(plugin.id);
      const isSameVersion =
        !plugin.version ||
        !installedVersion ||
        plugin.version === installedVersion;
      const manifestPath = isAbsolute(existingEntry.manifestPath)
        ? existingEntry.manifestPath
        : resolve(dirname(this.registryPath), existingEntry.manifestPath);
      if (existingEntry.pendingUpdate) this.clearInstallReceiptValidationForPlugin(canonicalPluginId);
      const receiptValidation = await this.getInstallReceiptValidation(plugin.id, manifestPath);
      const isSameArtifact = this.installedArtifactMatchesCatalog(plugin, receiptValidation);
      if (isSameVersion && receiptValidation.ok && isSameArtifact) {
        const manifestSha256 = await this.readManifestSha256(manifestPath);
        // Pass `null` as `bundleRootId` — auto-install of `dependencies[]`
        // is gone (issue #92), so no plugin is ever installed as a bundle
        // child of another. `mergeBundleRefs` treats `null` as no-op.
        await this.touchInstalledRegistryEntry(plugin.id, null, actor, plugin.pluginAccess, manifestSha256, state);
        await this.discardSupersededPendingBackup(existingEntry);
        await this.resolveObsoleteBackupOwnership(canonicalPluginId);
        return { pluginId: plugin.id, installed: true };
      }
      if (isSameVersion && !receiptValidation.ok) {
        log.warn(
          `installed plugin '${plugin.id}' has invalid install receipt (${receiptValidation.reason ?? "unknown"}) — reinstalling from marketplace`,
        );
      }
      if (isSameVersion && receiptValidation.ok && !isSameArtifact) {
        log.warn(
          `installed plugin '${plugin.id}' artifact hash differs from marketplace catalog — reinstalling same version`,
        );
      }
    }

    // Plugin↔app minimum-version gate — HARD BLOCK before downloading the
    // artifact. When the plugin declares `requires.minAppVersion` higher than
    // the running LVIS app, refuse the install and direct the user to update
    // the app. Absent = compatible with all (purely additive). Fail-closed:
    // an unresolvable app version ("unknown" sentinel) also blocks.
    const minAppVersion = plugin.requires?.minAppVersion;
    if (minAppVersion) {
      const currentAppVersion = getLvisAppVersion();
      if (!appVersionSatisfiesMin(currentAppVersion, minAppVersion)) {
        throw new IncompatibleAppVersionError(minAppVersion, currentAppVersion);
      }
    }

    // S14 — capability preflight. `requires.capabilities[]` is a separate
    // contract from plugin-id `dependencies[]`: any installed plugin that
    // advertises a matching `capabilities[]` tag satisfies the requirement.
    if (plugin.requires && plugin.requires.capabilities.length > 0) {
      const result = resolveDependencies(plugin.requires.capabilities, await getInstalledManifests());
      if (!result.ok) {
        throw new MissingDependenciesError(result.missing);
      }
    }

    // §3-B rollback support — snapshot the currently-installed manifest
    // before it gets overwritten so rollbackPlugin() can restore it.
    await this.snapshotCurrentInstall(canonicalPluginId);

    const dlVersion = plugin.version ?? "latest";
    let pendingEntry: PluginRegistryEntry | null = null;
    const manifestPath = await this.installArtifact(plugin, dlVersion, onProgress, {
      beforePromote: async (recoveryBackupDir) => {
        pendingEntry = await this.markMarketplaceRegistryEntryPending(
          existingEntry,
          recoveryBackupDir,
        );
      },
      commit: async (nextManifestPath, manifestAbsPath) => {
        const manifestSha256 = await this.readManifestSha256(manifestAbsPath);
        await this.commitMarketplaceRegistryEntry(
          plugin,
          nextManifestPath,
          manifestSha256,
          actor,
          existingEntry,
        );
      },
    }).catch((err) => this.restoreMarketplaceRegistryEntryAfterFailure(pendingEntry, existingEntry, err));
    const manifestAbsPath = isAbsolute(manifestPath)
      ? manifestPath
      : resolve(dirname(this.registryPath), manifestPath);
    await this.artifactStore.cacheVersionFromManifest(canonicalPluginId, manifestAbsPath);
    await this.appendHistoryFromManifestVersion(canonicalPluginId, manifestAbsPath);
    this.clearInstallReceiptValidationForPlugin(canonicalPluginId);
    await this.discardSupersededPendingBackup(existingEntry);
    state.installedPluginIds.push(plugin.id);
    return { pluginId: plugin.id, installed: true };
  }

  /**
   * Boot-time admin plugin bootstrap. Queries the marketplace catalog for
   * every admin-policy plugin and:
   *  - **force-installs** any that are missing from the local registry, and
   *  - **auto-updates** any installed one whose catalog version is strictly
   *    newer than the installed version.
   * Runs as actor="it-admin" so the install-policy guard permits the install.
   *
   * Auto-update rationale: admin-policy plugins are IT-managed, so the signed
   * catalog is the source of truth for which version should be deployed — when
   * it advertises a newer version, managed clients pick it up at boot without a
   * user click (the user-click update path stays for user-policy plugins). The
   * update is gated to *strictly newer* versions only: a same-or-older catalog
   * version leaves the installed plugin untouched (no surprise downgrades).
   *
   * Failure modes are intentionally graceful — marketplace unreachable or a
   * single plugin failing to install must NOT brick boot. Errors are logged
   * and the app continues without the failed plugins.
   */
  async ensureManagedInstalled(): Promise<{
    installed: string[];
    updated: string[];
    failed: Array<{ id: string; error: string }>;
  }> {
    const result = {
      installed: [] as string[],
      updated: [] as string[],
      failed: [] as Array<{ id: string; error: string }>,
    };
    let plugins: PluginMarketplaceItem[];
    try {
      plugins = await this.fetcher.listPlugins();
    } catch (err) {
      log.warn(
        `ensureManagedInstalled: catalog unreachable — skipping: ${(err as Error).message}`,
      );
      return result;
    }
    const managed = plugins.filter((p) => normalizeInstallPolicy(p) === "admin");
    if (managed.length === 0) return result;
    // Round-3 §6: registry read errors must propagate. ENOENT is already
    // handled inside readPluginRegistry (returns empty default for first
    // boot); a corrupt registry must NOT silently force-reinstall every
    // managed plugin on top of an unknown prior state.
    await readPluginRegistry(this.registryPath);
    for (const plugin of managed) {
      let isUpdate = false;
      try {
        // Boot-time managed bootstrap is an internal, trusted flow —
        // bypass the public `install()` entry (which derives actor from
        // catalog) and drive `installWithDependencies` directly with
        // actor="it-admin". This is the same trust anchor as the IPC
        // path (catalog → admin escalation). We pass the catalog snapshot
        // (`plugins`) we already fetched above so the install reads from one
        // consistent snapshot (#1098) rather than re-fetching the catalog.
        // installWithDependencies reinstalls to the catalog version when the
        // installed version differs, so the same call covers install + update.
        const state: InstallOperationState = {
          installedPluginIds: [],
          touchedEntries: new Map(),
        };
        const installKind = await this.withPluginLock(
          plugin.id,
          async (): Promise<"installed" | "updated" | "skipped"> => {
            const currentRegistry = await readPluginRegistry(this.registryPath);
            const installedIds = await this.resolveInstalledIds(currentRegistry.plugins);
            if (installedIds.has(plugin.id)) {
              let installedVersion: string | null;
              try {
                installedVersion = await this.readInstalledVersionFromRegistry(currentRegistry, plugin.id);
              } catch (err) {
                log.warn(
                  `ensureManagedInstalled: cannot read installed version for '${plugin.id}' — skipping update: ${(err as Error).message}`,
                );
                return "skipped";
              }
              if (!plugin.version || !installedVersion || !isNewer(plugin.version, installedVersion)) {
                return "skipped";
              }
              isUpdate = true;
              log.info(
                `ensureManagedInstalled: auto-updating managed plugin '${plugin.id}' ${installedVersion} → ${plugin.version}`,
              );
            }
            try {
              await this.installWithDependencies(plugin.id, "it-admin", plugins, new Set<string>(), state);
            } catch (innerErr) {
              try {
                await this.rollbackInstallOperation(state);
              } catch (rollbackError) {
                throw new AggregateError(
                  [innerErr, rollbackError],
                  `managed plugin install and rollback both failed: ${plugin.id}`,
                );
              }
              throw innerErr;
            }
            return isUpdate ? "updated" : "installed";
          },
        );
        if (installKind === "skipped") continue;
        result[installKind].push(plugin.id);
        this.clearInstallFailure(plugin.id);
      } catch (err) {
        const msg = (err as Error).message;
        result.failed.push({ id: plugin.id, error: msg });
        this.rememberInstallFailure(plugin, err);
        log.warn(`managed plugin '${plugin.id}' ${isUpdate ? "update" : "install"} failed: ${msg}`);
      }
    }
    return result;
  }

  async quarantinePlugin(
    pluginId: string,
    reason: string,
  ): Promise<{ pluginId: string; quarantined: true }> {
    return this.withPluginLock(pluginId, async () => {
      const registry = await readPluginRegistry(this.registryPath);
      const target = registry.plugins.find((entry) => entry.id === pluginId);
      if (target) {
        const expected = this.cloneRegistryEntry(target);
        const originals = this.ownedDirectoriesForEntry(expected)
          .map((path) => ({ pluginId, path }));
        await this.executeRemovalTransaction(
          "quarantine",
          [expected],
          [],
          originals,
          async () => updatePluginRegistry(this.registryPath, (fresh) => {
            const current = fresh.plugins.find((entry) => entry.id === pluginId);
            if (!current || canonicalJSON(current) !== canonicalJSON(expected)) {
              throw new Error(`Plugin registry changed during quarantine: ${pluginId}`);
            }
            fresh.plugins = fresh.plugins.filter((entry) => entry.id !== pluginId);
          }),
        );
      }
      log.warn(`quarantined plugin '${pluginId}' after failed install verification: ${reason}`);
      return { pluginId, quarantined: true as const };
    });
  }

  async uninstall(
    pluginId: string,
    options?: { removeBundleMembers?: boolean },
  ): Promise<{ pluginId: string; uninstalled: true }> {
    // §7.2 PluginDeploymentGuard — managed 플러그인은 user actor에게 차단.
    if (this.deploymentGuard) {
      const guardResult = await this.deploymentGuard.canUninstall(pluginId, "user");
      if (!guardResult.allowed) {
        const isOrphanedAdminInstall = await this.canUserRemoveOrphanedAdminInstall(pluginId, guardResult.reason);
        if (!isOrphanedAdminInstall) {
          throw new Error(guardResult.reason ?? `Plugin uninstall denied: ${pluginId}`);
        }
      }
    }

    const buildPlan = (entries: PluginRegistryEntry[]) => {
      const target = entries.find((entry) => entry.id === pluginId);
      if (!target) throw new Error(`Plugin not installed: ${pluginId}`);
      const idsToRemove = new Set<string>([pluginId]);
      const nextBundleRefs = new Map<string, string[]>();
      for (const entry of entries) {
        if (entry.id === pluginId) continue;
        const withoutRoot = (entry.bundleRefs ?? []).filter((bundleId) => bundleId !== pluginId);
        if (withoutRoot.length === (entry.bundleRefs ?? []).length) continue;
        if (options?.removeBundleMembers && withoutRoot.length === 0 && entry.installSource !== "admin") {
          idsToRemove.add(entry.id);
        } else {
          nextBundleRefs.set(entry.id, withoutRoot);
        }
      }
      const removed = entries
        .filter((entry) => idsToRemove.has(entry.id))
        .map((entry) => this.cloneRegistryEntry(entry));
      const affected = entries
        .filter((entry) => idsToRemove.has(entry.id) || nextBundleRefs.has(entry.id))
        .map((entry) => this.cloneRegistryEntry(entry))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const signature = canonicalJSON({
        affected,
        nextBundleRefs: [...nextBundleRefs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      });
      return { idsToRemove, nextBundleRefs, removed, affected, signature };
    };

    const snapshot = await readPluginRegistry(this.registryPath);
    const planned = buildPlan(snapshot.plugins);
    return this.withPluginLocks([...planned.idsToRemove], async () => {
      const lockedSnapshot = await readPluginRegistry(this.registryPath);
      const lockedPlan = buildPlan(lockedSnapshot.plugins);
      if (lockedPlan.signature !== planned.signature) {
        throw new Error(`Plugin registry changed before uninstall locks were acquired: ${pluginId}`);
      }
      const affectedIds = new Set(lockedPlan.affected.map((entry) => entry.id));
      const registryAfter = lockedSnapshot.plugins.map((entry) => this.cloneRegistryEntry(entry));
      for (const [id, refs] of lockedPlan.nextBundleRefs) {
        const entry = registryAfter.find((candidate) => candidate.id === id);
        if (entry) entry.bundleRefs = refs;
      }
      const projectedAfter = registryAfter.filter((entry) => affectedIds.has(entry.id) && !lockedPlan.idsToRemove.has(entry.id));
      const originals = lockedPlan.removed.flatMap((entry) =>
        this.ownedDirectoriesForEntry(entry).map((path) => ({ pluginId: entry.id, path })),
      );
      await this.executeRemovalTransaction(
        "uninstall",
        lockedPlan.affected,
        projectedAfter,
        originals,
        async () => updatePluginRegistry(this.registryPath, (registry) => {
          const fresh = buildPlan(registry.plugins);
          if (fresh.signature !== lockedPlan.signature) {
            throw new Error(`Plugin registry changed during uninstall: ${pluginId}`);
          }
          for (const [id, refs] of fresh.nextBundleRefs) {
            const entry = registry.plugins.find((candidate) => candidate.id === id);
            if (entry) entry.bundleRefs = refs;
          }
          registry.plugins = registry.plugins.filter((entry) => !fresh.idsToRemove.has(entry.id));
        }),
      );
      return { pluginId, uninstalled: true as const };
    });
  }

  private async canUserRemoveOrphanedAdminInstall(
    pluginId: string,
    denialReason: string | undefined,
  ): Promise<boolean> {
    if (!denialReason?.includes('registry installSource="admin"')) return false;

    const registry = await readPluginRegistry(this.registryPath);
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (entry?.installSource !== "admin") return false;

    let catalogPlugins: PluginMarketplaceItem[];
    try {
      catalogPlugins = await this.fetcher.listPlugins();
    } catch (err) {
      log.warn(
        `uninstall: keeping admin guard for '${pluginId}' because marketplace catalog could not be checked: ${(err as Error).message}`,
      );
      return false;
    }

    const stillManagedByCatalog = catalogPlugins.some((item) => catalogItemMatchesPluginId(item, pluginId));
    if (stillManagedByCatalog) return false;

    log.warn(`uninstall: allowing orphaned admin plugin cleanup for '${pluginId}' after marketplace removal`);
    return true;
  }

  /**
   * §9.6 — versioned install path. Thin wrapper around `install()`
   * that pins `packageSpec` to a specific version (npm semver) and leaves a
   * rollback breadcrumb. Callers can pass any marketplace pluginId; version
   * is used as the npm install target (e.g. `@lvis/foo@1.2.3`).
   */
  async installPlugin(
    pluginId: string,
    version: string,
    options?: { networkAccessAcknowledgement?: NetworkAccessAcknowledgement },
  ): Promise<{ pluginId: string; installed: true; version: string }> {
    return this.withPluginLock(pluginId, async () => {
      const plugins = await this.fetcher.listPlugins();
      const plugin = plugins.find((x) => x.id === pluginId);
      if (!plugin) {
        throw new Error(`Plugin not found in marketplace: ${pluginId}`);
      }
      if ((plugin.pluginType ?? "plugin") !== "plugin") {
        throw new Error(
          `Marketplace package "${pluginId}" is a ${plugin.pluginType} entry, not a plugin package`,
        );
      }
      assertNetworkAccessAcknowledgement({
        plugin,
        acknowledgement: options?.networkAccessAcknowledgement,
      });
      if (this.deploymentGuard) {
        const guardResult = await this.deploymentGuard.canInstall(
          pluginId,
          "user",
          plugin.installPolicy,
        );
        if (!guardResult.allowed) {
          throw new Error(guardResult.reason ?? `Plugin install denied: ${pluginId}`);
        }
      }

      const existingEntry = await this.getRawRegistryEntry(plugin.id);
      await this.snapshotCurrentInstall(pluginId);

      let pendingEntry: PluginRegistryEntry | null = null;
      const manifestPath = await this.installArtifact(plugin, version, undefined, {
        beforePromote: async (recoveryBackupDir) => {
          pendingEntry = await this.markMarketplaceRegistryEntryPending(existingEntry, recoveryBackupDir);
        },
        commit: async (nextManifestPath, manifestAbsPath) => {
          const manifestSha256 = await this.readManifestSha256(manifestAbsPath);
          await this.commitMarketplaceRegistryEntry(
            plugin,
            nextManifestPath,
            manifestSha256,
            "user",
            existingEntry,
          );
        },
      }).catch((err) => this.restoreMarketplaceRegistryEntryAfterFailure(pendingEntry, existingEntry, err));
      const manifestAbsPath = isAbsolute(manifestPath)
        ? manifestPath
        : resolve(dirname(this.registryPath), manifestPath);
      await this.artifactStore.cacheVersionFromManifest(pluginId, manifestAbsPath);
      await this.artifactStore.appendHistory(pluginId, {
        version,
        installedAt: new Date().toISOString(),
      });
      this.clearInstallReceiptValidationForPlugin(pluginId);
      await this.discardSupersededPendingBackup(existingEntry);
      return { pluginId: plugin.id, installed: true, version };
    });
  }

  /**
   * §9.6 — rollback to the prior cached version for `pluginId`.
   * Throws when no prior version is available.
   * Guarded by per-plugin mutex to avoid racing with installPlugin.
   */
  async rollbackPlugin(pluginId: string): Promise<{ pluginId: string; rolledBackTo: string }> {
    return this.withPluginLock(pluginId, async () => {
      const currentVersion = await this.getInstalledVersion(pluginId);
      const priorVersion = await this.artifactStore.findRollbackTarget(
        pluginId,
        currentVersion ?? undefined,
      );
      if (!priorVersion) {
        throw new Error(`No prior version cached for plugin: ${pluginId}`);
      }
      // Rollback: re-run the verified-zip install path with
      // the prior version. The marketplace server retains every published
      // version; the client's `cacheRoot` only tracks history (which versions
      // we've used), the binary itself is fetched fresh each time. No npm.
      const plugin = await this.fetcher.getPluginDetail(pluginId);
      if (!plugin) {
        // Delisted plugins cannot rollback: the marketplace server no
        // longer serves the artifact, so the verified-zip download path
        // has nothing to fetch. cacheRoot only persists the manifest
        // (history breadcrumb), not the binary, by design — caching the
        // binary locally would inflate the plugin tree with every install
        // and would outlive the security yank that a delisting is meant
        // to enforce. Surface the cause explicitly so settings UI / logs
        // can communicate it instead of a generic "not found".
        throw new Error(
          `Cannot rollback "${pluginId}": plugin is no longer in the marketplace catalog. ` +
            `Delisted plugins are unsupported for rollback (yanked artifacts are not retained locally).`,
        );
      }
      const registrySnapshot = await this.artifactStore.readCachedRegistryEntrySnapshot(pluginId, priorVersion);
      const existingEntry = await this.getRawRegistryEntry(pluginId);
      let pendingEntry: PluginRegistryEntry | null = null;
      try {
        await this.installArtifact(plugin, priorVersion, undefined, {
          validateCatalogMetadata: false,
          beforePromote: async (recoveryBackupDir) => {
            pendingEntry = await this.markMarketplaceRegistryEntryPending(existingEntry, recoveryBackupDir);
          },
          commit: async (manifestPathRel, manifestAbsPath) => {
            const manifestSha256 = await this.readManifestSha256(manifestAbsPath);
            await updatePluginRegistry(this.registryPath, (registry) => {
              const currentEntry = registry.plugins.find((entry) => entry.id === pluginId);
              const nextEntry: PluginRegistryEntry = {
                id: pluginId,
                manifestPath: manifestPathRel,
                manifestSha256,
                enabled: true,
                installSource: resolveRollbackInstallSource(existingEntry?.installSource, registrySnapshot?.installSource),
                bundleRefs: existingEntry?.bundleRefs ?? registrySnapshot?.bundleRefs ?? [],
                approvedPluginAccess: registrySnapshot?.approvedPluginAccess ?? existingEntry?.approvedPluginAccess,
                pendingCleanup: currentEntry ? cleanupJournalAfterCommit(currentEntry) : undefined,
              };
              const index = registry.plugins.findIndex((entry) => entry.id === pluginId);
              if (index >= 0) registry.plugins[index] = nextEntry;
              else registry.plugins.push(nextEntry);
            });
          },
        });
      } catch (err) {
        await this.restoreMarketplaceRegistryEntryAfterFailure(pendingEntry, existingEntry, err);
      }
      await this.artifactStore.appendHistory(pluginId, {
        version: priorVersion,
        installedAt: new Date().toISOString(),
      });
      this.clearInstallReceiptValidationForPlugin(pluginId);
      await this.discardSupersededPendingBackup(existingEntry);
      return { pluginId, rolledBackTo: priorVersion };
    });
  }

  /**
   * Per-plugin serialization. Concurrent callers for the same
   * pluginId queue behind each other; callers for different plugins run
   * concurrently. We keep the map entry only while the promise is pending.
   */
  private async withPluginLock<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(pluginId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    // `prev.then(() => next)` produces a NEW Promise object each call, so a
    // set + identity-compare against re-evaluated `prev.then(() => next)`
    // would never match and `this.locks` would leak one stale entry per
    // install. Hoist to a local so the same reference is stored + compared.
    const tail = prev.then(() => next);
    this.locks.set(pluginId, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.locks.get(pluginId) === tail) {
        this.locks.delete(pluginId);
      }
    }
  }

  /** Acquire all affected per-plugin operation locks in stable order. */
  private async withPluginLocks<T>(pluginIds: Iterable<string>, fn: () => Promise<T>): Promise<T> {
    const ids = [...new Set(pluginIds)].sort();
    const acquire = (index: number): Promise<T> => {
      if (index >= ids.length) return fn();
      return this.withPluginLock(ids[index]!, () => acquire(index + 1));
    };
    return acquire(0);
  }

  /**
   * Snapshot the currently-installed manifest into the artifact store's
   * version cache before overwrite. No-op when the plugin is not yet
   * installed. Wraps {@link PluginArtifactStore.cacheVersionFromManifest}
   * with the registry-aware path resolution that the store deliberately
   * does not own.
   */
  private async snapshotCurrentInstall(pluginId: string): Promise<void> {
    // Round-3 §6: do NOT swallow registry read errors here. `readPluginRegistry`
    // already returns the empty default on ENOENT (first-boot); any other
    // error (corrupt JSON, IO failure) must propagate so we don't silently
    // skip the rollback snapshot and then overwrite the install with an
    // unrecoverable previous state.
    const registry = await readPluginRegistry(this.registryPath);
    const entry = registry.plugins.find((p) => p.id === pluginId);
    if (!entry || entry.pendingUpdate) return;
    const manifestAbs = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    await this.artifactStore.cacheVersionFromManifest(pluginId, manifestAbs, entry);
    await this.appendHistoryFromManifestVersion(pluginId, manifestAbs);
  }

  private async appendHistoryFromManifestVersion(pluginId: string, manifestPath: string): Promise<void> {
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) return;
      await this.artifactStore.appendHistory(pluginId, {
        version: parsed.version,
        installedAt: new Date().toISOString(),
      });
    } catch (err) {
      log.warn(`appendHistoryFromManifestVersion failed for ${pluginId}: ${(err as Error).message}`);
    }
  }

  private async readManifestSha256(manifestPath: string): Promise<string> {
    const raw = await readFile(manifestPath, "utf-8");
    return shaOfManifest(JSON.parse(raw));
  }

  /** Raw durable row lookup for replacement planning, including stale manifests. */
  private async getRawRegistryEntry(pluginId: string): Promise<PluginRegistryEntry | null> {
    const registry = await readPluginRegistry(this.registryPath);
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    return entry ? this.cloneRegistryEntry(entry) : null;
  }

  /** Returns the version string from the currently-installed manifest, or null. */
  async getInstalledVersion(pluginId: string): Promise<string | null> {
    // Round-3 §6: registry read errors propagate; only the manifest-missing
    // path returns null (stale registry entry).
    const registry = await readPluginRegistry(this.registryPath);
    return this.readInstalledVersionFromRegistry(registry, pluginId);
  }

  /**
   * Installed version for a plugin, resolved from an already-loaded registry.
   * The single seam the managed-bootstrap loop uses so it does NOT re-read +
   * parse the whole registry file per plugin (it reuses the registry snapshot
   * it already holds). Manifest-missing (ENOENT) → null; other IO/parse errors
   * propagate to the caller, which isolates them per plugin.
   */
  private async readInstalledVersionFromRegistry(
    registry: { plugins: PluginRegistryEntry[] },
    pluginId: string,
  ): Promise<string | null> {
    const entry = registry.plugins.find((c) => c.id === pluginId);
    return entry && !entry.pendingUpdate ? this.readInstalledManifestVersion(entry) : null;
  }

  /**
   * Read the installed version from a registry entry's manifest. Split out of
   * {@link getInstalledVersion} so callers that already hold the registry (e.g.
   * the managed-bootstrap loop) don't re-read+parse the whole registry file per
   * plugin. Manifest-missing (ENOENT) → null; other IO/parse errors propagate.
   */
  private async readInstalledManifestVersion(entry: PluginRegistryEntry): Promise<string | null> {
    const manifestPath = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  }

  /**
   * Returns the live catalog version for an install/update request.
   *
   * This intentionally bypasses {@link list()} and its offline catalog cache:
   * update notifications are produced from the live fetcher, so the matching
   * install guard must compare the requested version against the same live
   * source instead of a still-valid-but-older cached catalog.
   */
  async getLiveCatalogVersion(pluginId: string): Promise<string | null> {
    const detail = await this.fetcher.getPluginDetail(pluginId);
    if (detail?.version) return detail.version;
    const plugins = await this.fetcher.listPlugins();
    const plugin = plugins.find((candidate) => candidate.id === pluginId || candidate.slug === pluginId);
    return plugin?.version ?? null;
  }

  private mergeBundleRefs(
    bundleRefs: string[] | undefined,
    bundleRootId: string | null,
    pluginId: string,
  ): string[] {
    if (!bundleRootId || bundleRootId === pluginId) {
      return bundleRefs ?? [];
    }
    return [...new Set([...(bundleRefs ?? []), bundleRootId])];
  }

  private async touchInstalledRegistryEntry(
    pluginId: string,
    bundleRootId: string | null,
    actor: "user" | "it-admin",
    approvedPluginAccess: PluginRegistryEntry["approvedPluginAccess"],
    manifestSha256: string,
    state?: InstallOperationState,
  ): Promise<void> {
    await updatePluginRegistry(this.registryPath, (registry) => {
      const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
      if (!entry) return;
      if (state && !state.touchedEntries.has(pluginId)) {
        state.touchedEntries.set(pluginId, {
          enabled: entry.enabled,
          bundleRefs: entry.bundleRefs ? [...entry.bundleRefs] : undefined,
          approvedPluginAccess: entry.approvedPluginAccess,
          installSource: entry.installSource,
          manifestSha256: entry.manifestSha256,
          pendingUpdate: entry.pendingUpdate ? { ...entry.pendingUpdate } : undefined,
          pendingCleanup: entry.pendingCleanup?.map((item) => ({ ...item })),
        });
      }
      entry.enabled = true;
      entry.manifestSha256 = manifestSha256;
      entry.installSource = actor === "it-admin" ? "admin" : entry.installSource ?? "user";
      entry.bundleRefs = this.mergeBundleRefs(entry.bundleRefs, bundleRootId, pluginId);
      entry.approvedPluginAccess = approvedPluginAccess;
      const pendingCleanup = cleanupJournalAfterCommit(entry);
      entry.pendingUpdate = undefined;
      entry.pendingCleanup = pendingCleanup;
    });
  }

  private async rollbackInstallOperation(state: InstallOperationState): Promise<void> {
    if (state.installedPluginIds.length === 0 && state.touchedEntries.size === 0) {
      return;
    }
    const affectedIds = new Set([...state.installedPluginIds, ...state.touchedEntries.keys()]);
    const snapshot = await readPluginRegistry(this.registryPath);
    const affectedSignature = (entries: PluginRegistryEntry[]) => canonicalJSON(
      entries
        .filter((entry) => affectedIds.has(entry.id))
        .map((entry) => this.cloneRegistryEntry(entry))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const plannedSignature = affectedSignature(snapshot.plugins);
    const entriesToRemove = snapshot.plugins
      .filter((entry) => state.installedPluginIds.includes(entry.id))
      .map((entry) => this.cloneRegistryEntry(entry));
    const registryAfter = snapshot.plugins.map((entry) => this.cloneRegistryEntry(entry));
    for (const pluginId of [...state.installedPluginIds].reverse()) {
      const index = registryAfter.findIndex((candidate) => candidate.id === pluginId);
      if (index >= 0) registryAfter.splice(index, 1);
    }
    for (const [pluginId, entrySnapshot] of state.touchedEntries) {
      const entry = registryAfter.find((candidate) => candidate.id === pluginId);
      if (!entry) continue;
      entry.enabled = entrySnapshot.enabled;
      entry.bundleRefs = entrySnapshot.bundleRefs;
      entry.approvedPluginAccess = entrySnapshot.approvedPluginAccess;
      if (entrySnapshot.manifestSha256) entry.manifestSha256 = entrySnapshot.manifestSha256;
      else delete entry.manifestSha256;
      if (entrySnapshot.installSource) entry.installSource = entrySnapshot.installSource;
      else delete entry.installSource;
      entry.pendingUpdate = entrySnapshot.pendingUpdate ? { ...entrySnapshot.pendingUpdate } : undefined;
      entry.pendingCleanup = entrySnapshot.pendingCleanup?.map((item) => ({ ...item }));
    }
    const registryBefore = snapshot.plugins.filter((entry) => affectedIds.has(entry.id));
    const projectedAfter = registryAfter.filter((entry) => affectedIds.has(entry.id));
    const originals = entriesToRemove.flatMap((entry) =>
      this.ownedDirectoriesForEntry(entry).map((path) => ({ pluginId: entry.id, path })),
    );

    await this.executeRemovalTransaction(
      "install-rollback",
      registryBefore,
      projectedAfter,
      originals,
      async () => updatePluginRegistry(this.registryPath, (registry) => {
        if (affectedSignature(registry.plugins) !== plannedSignature) {
          throw new Error("Plugin registry changed during install rollback");
        }
        for (const pluginId of [...state.installedPluginIds].reverse()) {
          registry.plugins = registry.plugins.filter((candidate) => candidate.id !== pluginId);
        }
        for (const [pluginId, entrySnapshot] of state.touchedEntries) {
          const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
          if (!entry) continue;
          entry.enabled = entrySnapshot.enabled;
          entry.bundleRefs = entrySnapshot.bundleRefs;
          entry.approvedPluginAccess = entrySnapshot.approvedPluginAccess;
          if (entrySnapshot.manifestSha256) entry.manifestSha256 = entrySnapshot.manifestSha256;
          else delete entry.manifestSha256;
          if (entrySnapshot.installSource) entry.installSource = entrySnapshot.installSource;
          else delete entry.installSource;
          entry.pendingUpdate = entrySnapshot.pendingUpdate ? { ...entrySnapshot.pendingUpdate } : undefined;
          entry.pendingCleanup = entrySnapshot.pendingCleanup?.map((item) => ({ ...item }));
        }
      }),
    );
  }

  private async executeRemovalTransaction(
    kind: RemovalTransactionKind,
    registryBefore: PluginRegistryEntry[],
    registryAfter: PluginRegistryEntry[],
    originals: Array<{ pluginId: string; path: string }>,
    commitRegistry: () => Promise<unknown>,
  ): Promise<void> {
    const pluginIds = [...new Set([...registryBefore, ...registryAfter].map((entry) => entry.id))].sort();
    const journal = await createRemovalTransaction(this.paths, {
      kind,
      pluginIds,
      registryBefore,
      registryAfter,
      originals: originals.filter((item) => existsSync(item.path)),
    });
    try {
      await stageRemovalTransaction(this.paths, journal);
      await commitRegistry();
    } catch (error) {
      try {
        await abortRemovalTransaction(this.paths, journal);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `${kind} and staged-directory restore both failed`);
      }
      throw error;
    }

    try {
      await markRemovalTransactionRegistryCommitted(this.paths, journal);
      await finishRemovalTransaction(this.paths, journal);
    } catch (error) {
      log.warn(
        { transactionId: journal.transactionId, kind, error },
        "committed plugin removal transaction retained for boot reconciliation",
      );
    }
  }

  private ownedDirectoriesForEntry(entry: PluginRegistryEntry): string[] {
    const directories = new Set<string>(pendingOwnedBackupPaths(this.paths, entry));
    directories.add(this.installedDirectoryForEntry(entry));
    return [...directories];
  }

  private installedDirectoryForEntry(entry: PluginRegistryEntry): string {
    return assertCanonicalRegistryOwnership(this.paths, entry);
  }

  /**
   * S14: load manifests for all currently-installed plugins so the dependency
   * resolver can inspect their `capabilities[]`.  Skips entries whose manifest
   * is missing (ENOENT — stale registry entry, fail-open per §S14: a single
   * stray manifest must not block unrelated installs). Other manifest IO /
   * parse errors propagate so corruption is surfaced rather than silently
   * dropping a real plugin from dependency resolution.
   *
   * Round-3 §6: registry read errors propagate (ENOENT is already returned
   * as the empty default inside readPluginRegistry).
   */
  private async loadInstalledManifests(): Promise<PluginManifest[]> {
    const registry = await readPluginRegistry(this.registryPath);
    const manifests: PluginManifest[] = [];
    for (const entry of registry.plugins) {
      if (entry.pendingUpdate) continue;
      if (entry.enabled === false) continue;
      const abs = isAbsolute(entry.manifestPath)
        ? entry.manifestPath
        : resolve(dirname(this.registryPath), entry.manifestPath);
      let raw: string;
      try {
        raw = await readFile(abs, "utf-8");
      } catch (err) {
        // ENOENT → stale registry entry; skip silently. Other errors
        // (permission, IO) propagate.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      manifests.push(JSON.parse(raw) as PluginManifest);
    }
    return manifests;
  }

  /**
   * Shared post-install finalization called by both installArtifact and
   * installLocal after the install dir is in place.
   *
   * Currently handles the receipt write only; registry update and entry-path
   * assertion are planned for a future expansion (#402 follow-up). Having a
   * single call site means receipt schema changes (e.g. adding a field) need
   * one edit here rather than one per install branch.
   */
  private async finalizeInstall(
    pluginId: string,
    opts: {
      version: string;
      installSource: "marketplace" | "local-dev";
      artifactSha256: string | null;
      signerKeyId: string | null;
      files: string[];
      installedAt?: string;
    },
  ): Promise<void> {
    await this.artifactStore.writeInstallReceipt(pluginId, opts);
  }

  /**
   * Install path — single source: download + verify + extract.
   *
   * The historical file:-spec / npm-install branch is gone. Production and
   * dev both fetch a signed zip from the marketplace API; the dev workflow
   * runs the marketplace server locally (default `http://localhost:8000`)
   * and publishes plugin artifacts via the server's CLI rather than
   * sideloading sibling-repo paths.
   */
  /**
   * Orchestrate one verified-zip install: delegate download + extract to
   * the artifact store, then layer plugin-specific manifest steps on top
   * (catalog-vs-zip validation; a zip missing plugin.json is rejected).
   * Returns the registry-relative manifest path.
   */
  private async installArtifact(
    plugin: PluginMarketplaceItem,
    version: string,
    onProgress?: (event: InstallerProgressEvent) => void,
    opts: {
      validateCatalogMetadata?: boolean;
      beforePromote?: (recoveryBackupDir: string) => Promise<void>;
      commit?: (manifestPath: string, manifestAbsPath: string) => Promise<void>;
    } = {},
  ): Promise<string> {
    return this.artifactStore.withArtifactResourceSlot(async () => {
      let priorReceiptRaw: string | undefined;
      try {
        priorReceiptRaw = await readFile(installReceiptPath(this.cacheRoot, plugin.id), "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const verified = await this.artifactStore.downloadVerifiedArtifact(plugin, version, onProgress);
      let receiptCommitted = false;
      try {
        const transaction = await this.artifactStore.extractZipWithCommit(
          plugin.id,
          verified.zipBuffer,
          async (pluginDir, extractedFiles) => {
            const manifestFile = resolve(pluginDir, "plugin.json");
            try {
              await readFile(manifestFile, "utf-8");
            } catch {
              throw new Error(
                `plugin "${plugin.id}" verified artifact is missing plugin.json — every published marketplace zip must ship its own manifest`,
              );
            }
            const validateCatalogMetadata =
              opts.validateCatalogMetadata ??
              (!plugin.version || plugin.version === version || version === "latest");
            await this.assertInstalledManifestMatchesCatalog(
              plugin,
              version,
              manifestFile,
              pluginDir,
              validateCatalogMetadata,
            );
            await this.finalizeInstall(plugin.id, {
              version,
              installSource: "marketplace",
              artifactSha256: verified.artifactSha256,
              signerKeyId: verified.signerKeyId,
              files: extractedFiles,
            });
            receiptCommitted = true;
            const manifestPath = toRegistryRelativeManifestPath(this.registryPath, manifestFile);
            await opts.commit?.(manifestPath, manifestFile);
            return manifestPath;
          },
          {
            beforePromote: opts.beforePromote,
            onCommittedBackupResolved: (obsoleteDir) =>
              clearObsoletePluginBackupOwnership(this.paths, plugin.id, obsoleteDir),
          },
        );
        return transaction.result;
      } catch (err) {
        if (!receiptCommitted) throw err;
        if (err instanceof ArtifactRollbackError) throw err;
        try {
          if (priorReceiptRaw === undefined) {
            await rm(installReceiptPath(this.cacheRoot, plugin.id), { force: true });
          } else {
            await restoreInstallReceiptRaw(this.cacheRoot, plugin.id, priorReceiptRaw);
          }
        } catch (receiptRestoreError) {
          throw new ArtifactRollbackError(
            `marketplace install and receipt rollback both failed: ${plugin.id}`,
            [err, receiptRestoreError],
          );
        }
        throw err;
      }
    });
  }

  private async commitMarketplaceRegistryEntry(
    plugin: PluginMarketplaceItem,
    manifestPath: string,
    manifestSha256: string,
    actor: "user" | "it-admin",
    previousEntry: PluginRegistryEntry | null = null,
  ): Promise<void> {
    await updatePluginRegistry(this.registryPath, (registry) => {
      const existing = registry.plugins.find((entry) => entry.id === plugin.id);
      if (existing) {
        const pendingCleanup = cleanupJournalAfterCommit(existing);
        existing.manifestPath = manifestPath;
        existing.manifestSha256 = manifestSha256;
        existing.enabled = true;
        existing.installSource = actor === "it-admin" ? "admin" : "user";
        existing.bundleRefs = this.mergeBundleRefs(existing.bundleRefs, null, plugin.id);
        existing.approvedPluginAccess = plugin.pluginAccess;
        existing.pendingUpdate = undefined;
        existing.pendingCleanup = pendingCleanup;
      } else {
        registry.plugins.push({
          id: plugin.id,
          manifestPath,
          manifestSha256,
          enabled: true,
          installSource: actor === "it-admin" ? "admin" : "user",
          bundleRefs: this.mergeBundleRefs(previousEntry?.bundleRefs ?? [], null, plugin.id),
          approvedPluginAccess: plugin.pluginAccess,
        });
      }
    });
  }

  private async markMarketplaceRegistryEntryPending(
    expectedEntry: PluginRegistryEntry | null,
    recoveryBackupDir: string,
  ): Promise<PluginRegistryEntry | null> {
    if (!expectedEntry) return null;
    return preparePendingPluginUpdate(this.paths, expectedEntry, {
      kind: "marketplace",
      recoveryBackupDir,
      recoveryBackupMode: "rename",
    });
  }

  private async restoreMarketplaceRegistryEntryAfterFailure(
    pendingEntry: PluginRegistryEntry | null,
    previousEntry: PluginRegistryEntry | null,
    installError: unknown,
  ): Promise<never> {
    if (!pendingEntry) {
      throw installError;
    }
    if (installError instanceof ArtifactRollbackError && !previousEntry?.pendingUpdate) {
      throw installError;
    }
    try {
      if (previousEntry?.pendingUpdate) {
        await restoreSupersededPendingPluginUpdate(this.paths, pendingEntry, previousEntry, {
          preserveRetryCleanup: installError instanceof ArtifactRollbackError,
        });
      } else {
        const recovery = await recoverPendingPluginUpdate(this.paths, pendingEntry.id);
        if (recovery !== "recovered") {
          throw new Error(`marketplace update recovery remains unresolved: ${pendingEntry.id}`);
        }
      }
    } catch (registryRestoreError) {
      throw new AggregateError(
        [installError, registryRestoreError],
        `marketplace install and registry rollback both failed: ${pendingEntry.id}`,
      );
    }
    throw installError;
  }

  /** Boot/retry lifecycle for crash-interrupted replacement rows. */
  async recoverInterruptedUpdates(): Promise<{ recovered: string[]; unresolved: string[] }> {
    return recoverPendingPluginUpdates(this.paths);
  }

  /** Explicitly retry restoration of one retained replacement backup. */
  async restorePendingUpdate(pluginId: string): Promise<"recovered" | "unresolved" | "absent"> {
    return this.withPluginLock(pluginId, () => recoverPendingPluginUpdate(this.paths, pluginId));
  }

  /**
   * Explicitly discard a retained backup after operator review. The registry
   * row intentionally remains pending/hidden until a verified reinstall.
   */
  async cleanupPendingUpdateBackup(pluginId: string): Promise<boolean> {
    return this.withPluginLock(pluginId, () => cleanupPendingPluginUpdateBackup(this.paths, pluginId));
  }

  /** Explicitly retry cleanup of an obsolete, never-restorable artifact directory. */
  async cleanupObsoleteBackup(pluginId: string): Promise<boolean> {
    return this.withPluginLock(pluginId, () => cleanupObsoletePluginBackup(this.paths, pluginId));
  }

  private async discardSupersededPendingBackup(entry: PluginRegistryEntry | null): Promise<void> {
    if (!entry?.pendingUpdate?.recoveryBackupDir) return;
    await cleanupObsoletePluginBackupPath(this.paths, entry.id, entry.pendingUpdate.recoveryBackupDir).catch((err) => {
      log.warn(`superseded recovery backup retained for ${entry.id}: ${(err as Error).message}`);
    });
  }

  private async resolveObsoleteBackupOwnership(pluginId: string): Promise<void> {
    await cleanupObsoletePluginBackup(this.paths, pluginId).catch((err) => {
      log.warn(`obsolete plugin backup retained for ${pluginId}: ${(err as Error).message}`);
    });
  }

  private async assertInstalledManifestMatchesCatalog(
    plugin: PluginMarketplaceItem,
    version: string,
    manifestFile: string,
    pluginDir: string,
    validateCatalogMetadata = true,
  ): Promise<void> {
    try {
      const raw = await readFile(manifestFile, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`plugin "${plugin.id}" manifest must be a JSON object`);
      }

      const manifest = parsed as Partial<PluginManifest> & Record<string, unknown>;
      if (manifest.id !== plugin.id) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest id mismatch: expected "${plugin.id}", got "${String(manifest.id ?? "")}"`,
        );
      }

      if (STABLE_SEMVER_RE.test(version) && manifest.version !== version) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest version mismatch: expected "${version}", got "${String(manifest.version ?? "")}"`,
        );
      }

      if (validateCatalogMetadata) {
        const expectedInstallPolicy = plugin.installPolicy ?? "user";
        const actualInstallPolicy = manifest.installPolicy ?? "user";
        if (actualInstallPolicy !== expectedInstallPolicy) {
          throw new Error(
            `plugin "${plugin.id}" artifact manifest installPolicy mismatch: expected "${expectedInstallPolicy}", got "${String(actualInstallPolicy)}"`,
          );
        }

        const expectedPluginAccess = plugin.pluginAccess ?? undefined;
        const actualPluginAccess = manifest.pluginAccess ?? undefined;
        if (JSON.stringify(actualPluginAccess) !== JSON.stringify(expectedPluginAccess)) {
          throw new Error(
            `plugin "${plugin.id}" artifact manifest pluginAccess does not match the catalog-approved grant`,
          );
        }

        if (!networkAccessGrantsEqual(plugin.networkAccess, manifest.networkAccess)) {
          throw new Error(
            `plugin "${plugin.id}" artifact manifest networkAccess does not match the catalog-approved grant`,
          );
        }
        const runtimeCapabilityMismatches = findRuntimeCapabilityMismatches(plugin, manifest);
        if (runtimeCapabilityMismatches.length > 0) {
          throw new Error(
            `plugin "${plugin.id}" artifact manifest ${runtimeCapabilityMismatches.join(", ")} capability does not match the catalog-approved grant`,
          );
        }

        const expectedDependencies = normalizeDependencies(plugin);
        const actualDependencies = normalizeDependencies(
          manifest as Pick<PluginManifest, "dependencies">,
        );
        if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
          throw new Error(
            `plugin "${plugin.id}" artifact manifest dependencies do not match the catalog-approved dependencies`,
          );
        }
      }
    } catch (err) {
      await rm(pluginDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async resolveInstalledIds(
    entries: PluginRegistryEntry[],
  ): Promise<Set<string>> {
    const installedIds = new Set<string>();
    for (const entry of entries) {
      if (entry.pendingUpdate) continue;
      const manifestPath = isAbsolute(entry.manifestPath)
        ? entry.manifestPath
        : resolve(dirname(this.registryPath), entry.manifestPath);
      try {
        await readFile(manifestPath, "utf-8");
        const receiptValidation = await this.getInstallReceiptValidation(entry.id, manifestPath);
        if (receiptValidation.ok) {
          installedIds.add(entry.id);
        } else {
          log.warn(
            `installed plugin '${entry.id}' ignored during managed bootstrap: invalid install receipt (${receiptValidation.reason ?? "unknown"})`,
          );
        }
      } catch {
        log.warn(
          `stale registry entry ignored during managed bootstrap: ${entry.id}`,
        );
      }
    }
    return installedIds;
  }

  private async getInstallReceiptValidation(
    pluginId: string,
    manifestPath: string,
  ): Promise<InstallReceiptValidation> {
    const cacheKey = this.installReceiptValidationCacheKey(pluginId, manifestPath);
    const cached = this.installReceiptValidationCache.get(cacheKey);
    if (cached) return cached;

    const pluginRoot = dirname(manifestPath);
    const result = await verifyInstallReceipt(this.cacheRoot, pluginId, pluginRoot);
    if (!result.ok) {
      const validation = { ok: false, reason: result.reason };
      this.installReceiptValidationCache.set(cacheKey, validation);
      return validation;
    }
    if (result.receipt.installSource === "local-dev" && !isDevModeUnlocked()) {
      const validation = { ok: false, reason: "local-dev install is not allowed in this build" };
      this.installReceiptValidationCache.set(cacheKey, validation);
      return validation;
    }
    const validation: InstallReceiptValidation = { ok: true, receipt: result.receipt };
    this.installReceiptValidationCache.set(cacheKey, validation);
    return validation;
  }

  private installedArtifactMatchesCatalog(
    plugin: PluginMarketplaceItem,
    validation: InstallReceiptValidation,
  ): boolean {
    if (!validation.ok || !validation.receipt) return false;
    if (validation.receipt.installSource !== "marketplace") return false;
    if (!plugin.artifactSha256) return true;
    return validation.receipt.artifactSha256 === plugin.artifactSha256;
  }

  private clearInstallReceiptValidationForPlugin(pluginId: string): void {
    const prefix = `${pluginId}\0`;
    for (const key of this.installReceiptValidationCache.keys()) {
      if (key.startsWith(prefix)) {
        this.installReceiptValidationCache.delete(key);
      }
    }
  }

  private installReceiptValidationCacheKey(pluginId: string, manifestPath: string): string {
    return `${pluginId}\0${resolve(manifestPath)}`;
  }

  /**
   * Dev-only: copy a locally-built plugin directory into ~/.lvis/plugins/<id>/
   * and register it in the plugin registry. Gated on isDevModeUnlocked() so
   * packaged builds cannot invoke this path.
   */
  async resolveLocalInstallPluginId(sourcePath: string): Promise<string> {
    if (!isDevModeUnlocked()) {
      throw new Error(
        "[security] installLocal requires dev mode — enable a supported LVIS_DEV* flag in a non-packaged build",
      );
    }

    let srcStat: Awaited<ReturnType<typeof statAsync>>;
    try {
      srcStat = await statAsync(sourcePath);
    } catch {
      throw new Error(`[installLocal] path does not exist: ${sourcePath}`);
    }
    if (!srcStat.isDirectory()) {
      throw new Error(`[installLocal] path is not a directory: ${sourcePath}`);
    }

    const manifestPath = resolve(sourcePath, "plugin.json");
    let manifest: { id?: unknown };
    try {
      const raw = await readFile(manifestPath, "utf-8");
      manifest = JSON.parse(raw) as { id?: unknown };
    } catch {
      throw new Error(`[installLocal] could not read plugin.json in ${sourcePath}`);
    }

    const pluginId = typeof manifest.id === "string" ? manifest.id.trim() : "";
    if (!pluginId) {
      throw new Error("[installLocal] plugin.json must have a non-empty 'id' field");
    }
    try {
      assertSafeArtifactSlug(pluginId);
    } catch {
      throw new Error(
        `[installLocal] unsafe plugin id — must match ^[a-zA-Z0-9._-]+$: ${pluginId}`,
      );
    }
    return pluginId;
  }

  async installLocal(sourcePath: string): Promise<{ pluginId: string; installed: true }> {
    if (!isDevModeUnlocked()) {
      throw new Error(
        "[security] installLocal requires dev mode — enable a supported LVIS_DEV* flag in a non-packaged build",
      );
    }

    // Validate the source path exists and is a directory (non-blocking).
    let srcStat: Awaited<ReturnType<typeof statAsync>>;
    try {
      srcStat = await statAsync(sourcePath);
    } catch {
      throw new Error(`[installLocal] path does not exist: ${sourcePath}`);
    }
    if (!srcStat.isDirectory()) {
      throw new Error(`[installLocal] path is not a directory: ${sourcePath}`);
    }

    // Read and parse plugin.json from the source directory.
    const manifestPath = resolve(sourcePath, "plugin.json");
    let manifest: { id?: unknown; [key: string]: unknown };
    try {
      const raw = await readFile(manifestPath, "utf-8");
      manifest = JSON.parse(raw) as { id?: unknown; [key: string]: unknown };
    } catch {
      throw new Error(`[installLocal] could not read plugin.json in ${sourcePath}`);
    }

    const pluginId = typeof manifest.id === "string" ? manifest.id.trim() : "";
    if (!pluginId) {
      throw new Error("[installLocal] plugin.json must have a non-empty 'id' field");
    }

    // Validate pluginId is a safe directory name.
    try {
      assertSafeArtifactSlug(pluginId);
    } catch {
      throw new Error(
        `[installLocal] unsafe plugin id — must match ^[a-zA-Z0-9._-]+$: ${pluginId}`,
      );
    }

    // Validate version up front — same throw message as the receipt-write
    // step, but BEFORE any filesystem mutation (cp / rename / registry
    // update) so a malformed manifest does not leave a half-installed
    // plugin dir + registry entry behind requiring manual cleanup.
    if (typeof manifest.version !== "string" || !manifest.version) {
      throw new Error(
        `[installLocal] plugin.json must declare a non-empty 'version' string: ${pluginId}`,
      );
    }
    const manifestVersion = manifest.version;

    return this.withPluginLock(pluginId, async () => {
      const userPluginsRoot = this.pluginsRoot;
      const installDir = resolve(userPluginsRoot, pluginId);

      // Refuse to clobber an admin-installed plugin under the same id —
      // dev sideload should not silently downgrade an admin-managed entry.
      const existingRegistry = await readPluginRegistry(this.registryPath);
      const existingEntry = existingRegistry.plugins.find((p) => p.id === pluginId);
      if (existingEntry?.installSource === "admin") {
        throw new Error(
          `[installLocal] refusing to overwrite admin-installed plugin: ${pluginId}`,
        );
      }
      const rollbackSnapshot = existingEntry
        ? existingEntry.pendingUpdate
          ? {
              kind: "pending-predecessor" as const,
              installDir,
              registryEntry: this.cloneRegistryEntry(existingEntry),
            }
          : await this.createLocalInstallRollbackSnapshot(pluginId, installDir, existingEntry)
        : null;

      try {
        // Stage the copy under a sibling tmp dir so an interrupted install
        // never leaves the live install path half-written. The final rename
        // is atomic on the same filesystem (which ~/.lvis/plugins/ guarantees).
        const stagingDir = resolve(userPluginsRoot, `${pluginId}.tmp-${process.pid}-${Date.now()}`);
        await rm(stagingDir, { recursive: true, force: true });
        try {
          await cp(sourcePath, stagingDir, {
            recursive: true,
            verbatimSymlinks: true,
            filter: buildSideloadCopyFilter(sourcePath),
          });
          // Check for escaping symlinks in staging before rename so a failed
          // check never touches the live install path — rollback is just rm(staging).
          await rejectEscapingSymlinks(stagingDir);
          if (existingEntry) {
            await preparePendingPluginUpdate(this.paths, existingEntry, {
              kind: "local-dev",
              ...(rollbackSnapshot?.backupDir
                ? { recoveryBackupDir: rollbackSnapshot.backupDir, recoveryBackupMode: "copy" as const }
                : {}),
            });
          }
          await rm(installDir, { recursive: true, force: true });
          await rename(stagingDir, installDir);
        } catch (err) {
          await rm(stagingDir, { recursive: true, force: true });
          throw err;
        }

        // Register in the plugin registry. installSource follows the
        // manifest's declared installPolicy so dev-sideloading an admin-policy
        // manifest doesn't silently downgrade it to a user install.
        //
        // #1098 — intentional boundary difference from marketplace install:
        // there is NO actor-escalation audit here. Marketplace escalation is
        // audited because the catalog is a remote trust anchor whose policy the
        // user did not author; here the installPolicy comes from a local,
        // developer-controlled manifest and the whole path is gated upstream by
        // `isDevModeUnlocked()`, so the developer IS the authority — there is no
        // user→it-admin escalation event to record. The admin-overwrite guard
        // above still prevents a sideload from clobbering a managed install.
        const localInstallSource: PluginRegistryEntryInstallSource =
          manifest.installPolicy === "admin" ? "admin" : "local-dev";
        const registryManifestPath = posix.join(pluginId, "plugin.json");
        const manifestSha256 = shaOfManifest(manifest);
        // Mirror the marketplace install path's grant of `manifest.pluginAccess`
        // into `approvedPluginAccess`. Without this,
        // `assertPluginEventAccess` finds no grant for a dev-sideloaded plugin
        // and any cross-plugin event subscribe / emit from its createPlugin
        // path throws "not allowed to subscribe to
        // event ... from plugin ...". Dev mode is gated by `isDevModeUnlocked()`
        // upstream, so this isn't an additional trust delegation — just brings
        // installLocal to parity with marketplace install.
        const approvedPluginAccess = (manifest as { pluginAccess?: PluginAccessSpec }).pluginAccess;
        // The integrity receipt covers every regular payload file. Runtime
        // verification compares this exact normalized set with disk, so an
        // injected executable or other unlisted payload is rejected.
        const receiptFiles = await listFilesRecursive(installDir);
        await this.finalizeInstall(pluginId, {
          version: manifestVersion,
          installSource: "local-dev",
          artifactSha256: null,
          signerKeyId: null,
          files: receiptFiles,
        });

        // Publish registry visibility only after the install directory and
        // its exact receipt are both durable.
        await updatePluginRegistry(this.registryPath, (registry) => {
          const existing = registry.plugins.find((x) => x.id === pluginId);
          if (existing) {
            const pendingCleanup = cleanupJournalAfterCommit(existing);
            existing.manifestPath = registryManifestPath;
            existing.manifestSha256 = manifestSha256;
            existing.enabled = true;
            existing.installSource = localInstallSource;
            existing.approvedPluginAccess = approvedPluginAccess;
            existing.pendingUpdate = undefined;
            existing.pendingCleanup = pendingCleanup;
          } else {
            registry.plugins.push({
              id: pluginId,
              manifestPath: registryManifestPath,
              manifestSha256,
              enabled: true,
              installSource: localInstallSource,
              approvedPluginAccess,
            });
          }
        });
        this.clearInstallReceiptValidationForPlugin(pluginId);
        if (!existingEntry?.pendingUpdate) {
          await this.discardSupersededPendingBackup(existingEntry ?? null);
        }

        const previousSnapshot = this.localInstallRollbackSnapshots.get(pluginId);
        if (previousSnapshot) {
          await this.discardLocalInstallRollbackSnapshot(previousSnapshot);
        }
        if (rollbackSnapshot) {
          this.localInstallRollbackSnapshots.set(pluginId, rollbackSnapshot);
        } else {
          this.localInstallRollbackSnapshots.delete(pluginId);
        }
        return { pluginId, installed: true as const };
      } catch (err) {
        const rollbackErrors: unknown[] = [];
        let restored = false;
        if (rollbackSnapshot) {
          try {
            await this.restoreLocalInstallSnapshot(pluginId, rollbackSnapshot);
            restored = true;
          } catch (restoreErr) {
            log.warn(`installLocal rollback restore failed for ${pluginId}: ${(restoreErr as Error).message}`);
            rollbackErrors.push(restoreErr);
            const previousSnapshot = this.localInstallRollbackSnapshots.get(pluginId);
            if (previousSnapshot && previousSnapshot !== rollbackSnapshot) {
              try {
                await this.discardLocalInstallRollbackSnapshot(previousSnapshot);
              } catch (cleanupErr) {
                rollbackErrors.push(cleanupErr);
              }
            }
            this.localInstallRollbackSnapshots.set(pluginId, rollbackSnapshot);
          }
        } else {
          try {
            await this.cleanupFreshInstalledPlugin(pluginId);
          } catch (cleanupErr) {
            log.warn(`installLocal fresh cleanup failed for ${pluginId}: ${(cleanupErr as Error).message}`);
            rollbackErrors.push(cleanupErr);
          }
        }
        if (restored) {
          try {
            await this.discardLocalInstallRollbackSnapshot(rollbackSnapshot);
          } catch (cleanupErr) {
            log.warn(`installLocal rollback snapshot cleanup failed for ${pluginId}: ${(cleanupErr as Error).message}`);
            rollbackErrors.push(cleanupErr);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [err, ...rollbackErrors],
            `local plugin install and rollback both failed: ${pluginId}`,
          );
        }
        throw err;
      }
    });
  }

  async rollbackLocalInstall(pluginId: string): Promise<{ pluginId: string; rolledBack: true }> {
    return this.withPluginLock(pluginId, async () => {
      const snapshot = this.localInstallRollbackSnapshots.get(pluginId);
      if (!snapshot) {
        throw new Error(`No local install rollback snapshot for plugin: ${pluginId}`);
      }
      await this.restoreLocalInstallSnapshot(pluginId, snapshot);
      this.localInstallRollbackSnapshots.delete(pluginId);
      await this.discardLocalInstallRollbackSnapshot(snapshot);
      return { pluginId, rolledBack: true as const };
    });
  }

  async clearLocalInstallRollback(pluginId: string): Promise<void> {
    return this.withPluginLock(pluginId, async () => {
      const snapshot = this.localInstallRollbackSnapshots.get(pluginId);
      if (!snapshot) return;
      this.localInstallRollbackSnapshots.delete(pluginId);
      await this.discardLocalInstallRollbackSnapshot(snapshot);
    });
  }

  private async createLocalInstallRollbackSnapshot(
    pluginId: string,
    installDir: string,
    existingEntry: PluginRegistryEntry,
  ): Promise<LocalInstallRollbackSnapshot> {
    const snapshot: LocalInstallRollbackSnapshot = {
      kind: "filesystem-snapshot",
      installDir,
      registryEntry: this.cloneRegistryEntry(existingEntry),
    };
    try {
      snapshot.receiptRaw = await readFile(installReceiptPath(this.cacheRoot, pluginId), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      const current = await statAsync(installDir);
      if (!current.isDirectory()) return snapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return snapshot;
      throw err;
    }
    const backupRoot = resolve(this.pluginsRoot, ".cache", "local-install-rollback");
    await mkdir(backupRoot, { recursive: true });
    const backupDir = resolve(backupRoot, `${pluginId}-${process.pid}-${Date.now()}`);
    await rm(backupDir, { recursive: true, force: true });
    await cp(installDir, backupDir, { recursive: true, verbatimSymlinks: true });
    snapshot.backupDir = backupDir;
    return snapshot;
  }

  private cloneRegistryEntry(entry: PluginRegistryEntry): PluginRegistryEntry {
    return {
      ...entry,
      bundleRefs: entry.bundleRefs ? [...entry.bundleRefs] : undefined,
      approvedPluginAccess: entry.approvedPluginAccess,
      pendingUpdate: entry.pendingUpdate ? { ...entry.pendingUpdate } : undefined,
      pendingCleanup: entry.pendingCleanup?.map((item) => ({ ...item })),
    };
  }

  private async restoreLocalInstallSnapshot(
    pluginId: string,
    snapshot: LocalInstallRollbackSnapshot | null,
  ): Promise<void> {
    if (!snapshot) return;
    if (snapshot.kind === "pending-predecessor") {
      if (!snapshot.registryEntry.pendingUpdate) {
        throw new Error(`Pending local rollback predecessor metadata missing: ${pluginId}`);
      }
      await updatePluginRegistry(this.registryPath, (registry) => {
        const restoredEntry = this.cloneRegistryEntry(snapshot.registryEntry);
        const existingIndex = registry.plugins.findIndex((entry) => entry.id === pluginId);
        if (existingIndex >= 0) registry.plugins[existingIndex] = restoredEntry;
        else registry.plugins.push(restoredEntry);
      });
      const outcome = await recoverPendingPluginUpdate(this.paths, pluginId);
      if (outcome !== "recovered") {
        throw new Error(`Pending local rollback predecessor remains unresolved: ${pluginId}`);
      }
      this.clearInstallReceiptValidationForPlugin(pluginId);
      return;
    }
    await readPluginRegistry(this.registryPath);
    await rm(snapshot.installDir, { recursive: true, force: true });
    if (snapshot.backupDir) {
      const restoreStageDir = `${snapshot.installDir}.restore-${process.pid}-${Date.now()}`;
      await rm(restoreStageDir, { recursive: true, force: true });
      try {
        await cp(snapshot.backupDir, restoreStageDir, { recursive: true, verbatimSymlinks: true });
        await retryOnTransientFsLock(() => rename(restoreStageDir, snapshot.installDir), {
          onRetry: (attempt, code) =>
            log.warn({ pluginId, attempt, code }, "retrying local rollback directory restore under fs lock"),
        });
      } catch (err) {
        await rm(restoreStageDir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
    }
    const receiptPath = installReceiptPath(this.cacheRoot, pluginId);
    if (snapshot.receiptRaw !== undefined) {
      await restoreInstallReceiptRaw(this.cacheRoot, pluginId, snapshot.receiptRaw);
    } else {
      await rm(receiptPath, { force: true });
    }
    await updatePluginRegistry(this.registryPath, (registry) => {
      const restoredEntry = this.cloneRegistryEntry(snapshot.registryEntry);
      const existingIndex = registry.plugins.findIndex((entry) => entry.id === pluginId);
      if (existingIndex >= 0) {
        const currentCleanup = registry.plugins[existingIndex]?.pendingCleanup ?? [];
        const restoredCleanup = restoredEntry.pendingCleanup ?? [];
        const mergedCleanup = [...restoredCleanup.map((item) => ({ ...item }))];
        for (const item of currentCleanup) {
          if (!mergedCleanup.some((candidate) => resolve(candidate.path) === resolve(item.path))) {
            mergedCleanup.push({ ...item });
          }
        }
        restoredEntry.pendingCleanup = mergedCleanup.length > 0 ? mergedCleanup : undefined;
        registry.plugins[existingIndex] = restoredEntry;
      } else {
        registry.plugins.push(restoredEntry);
      }
    });
    this.clearInstallReceiptValidationForPlugin(pluginId);
  }

  private async cleanupFreshInstalledPlugin(pluginId: string): Promise<void> {
    const installDir = resolve(this.pluginsRoot, pluginId);
    await updatePluginRegistry(this.registryPath, (registry) => {
      registry.plugins = registry.plugins.filter((entry) => entry.id !== pluginId);
    });
    await rm(installDir, { recursive: true, force: true });
    await rm(installReceiptPath(this.cacheRoot, pluginId), { force: true });
    this.clearInstallReceiptValidationForPlugin(pluginId);
  }

  private async discardLocalInstallRollbackSnapshot(
    snapshot: LocalInstallRollbackSnapshot | null,
  ): Promise<void> {
    if (snapshot?.kind === "pending-predecessor") {
      const backupDir = snapshot.registryEntry.pendingUpdate?.recoveryBackupDir;
      if (backupDir) {
        await cleanupObsoletePluginBackupPath(this.paths, snapshot.registryEntry.id, backupDir);
      }
      return;
    }
    if (snapshot?.backupDir) {
      await rm(snapshot.backupDir, { recursive: true, force: true });
      await clearObsoletePluginBackupOwnership(
        this.paths,
        snapshot.registryEntry.id,
        snapshot.backupDir,
      );
    }
  }

}
