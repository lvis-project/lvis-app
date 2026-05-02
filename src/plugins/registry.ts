import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { InstallPolicy, PluginRegistry, PluginRegistryEntry, PluginRegistryEntryInstallSource } from "./types.js";
import { plog, PluginPhase } from "./lifecycle-log.js";

/**
 * Pre-PR #430 registry shape — `installedBy` ("admin"|"user") and
 * `_devLinked` (boolean) carried the install-source signal as two
 * orthogonal fields. PR #430 collapsed both into the single
 * `installSource` enum. {@link migrateLegacyEntry} maps the legacy
 * shape onto the new enum and strips the deprecated fields, and
 * {@link readPluginRegistry} persists the migrated form back to disk
 * the first time it sees a legacy entry — making the migration
 * one-shot and idempotent.
 *
 * Post-2026-05 dev-link removal: the `"dev-link"` value (whether stored
 * directly in `installSource` or implied by the legacy `_devLinked: true`
 * boolean) is rewritten to `"local-dev"` on read with a loud audit
 * warning. There is no in-flight dev-link runtime any longer — the
 * receipt-check bypass is gone and any entry created by the old
 * `bun run dev:link` script can no longer load. Treating it as
 * `"local-dev"` is the closest still-valid sibling so the operator
 * sees a clear failure (missing receipt) instead of a silent skip.
 */
interface LegacyRegistryEntry extends Omit<PluginRegistryEntry, "installSource"> {
  installedBy?: InstallPolicy;
  _devLinked?: boolean;
  /**
   * Pre-2026-05 registries may carry `installSource: "dev-link"`. The
   * union no longer accepts this value at compile time, so the legacy
   * shape is widened with a string here. {@link migrateLegacyEntry}
   * normalises it to `"local-dev"`.
   */
  installSource?: PluginRegistryEntryInstallSource | "dev-link";
}

const PAGEINDEX_LEGACY_PLUGIN_ID = "pageindex";
const LOCAL_INDEXER_PLUGIN_ID = "local-indexer";
const PAGEINDEX_LEGACY_DEFAULT_MANIFEST_PATH = "pageindex/plugin.json";
const LOCAL_INDEXER_DEFAULT_MANIFEST_PATH = "local-indexer/plugin.json";

function renamePageindexDefaultManifestPath(manifestPath: string): string {
  return manifestPath === PAGEINDEX_LEGACY_DEFAULT_MANIFEST_PATH
    ? LOCAL_INDEXER_DEFAULT_MANIFEST_PATH
    : manifestPath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function withLocalIndexerIdentity(entry: PluginRegistryEntry): PluginRegistryEntry {
  return {
    ...entry,
    id: LOCAL_INDEXER_PLUGIN_ID,
    manifestPath: renamePageindexDefaultManifestPath(entry.manifestPath),
  };
}

function mergeMissingPageindexMetadata(
  canonical: PluginRegistryEntry,
  source: PluginRegistryEntry,
): void {
  if (canonical.enabled === undefined && source.enabled !== undefined) canonical.enabled = source.enabled;
  if (canonical.installSource === undefined && source.installSource !== undefined) canonical.installSource = source.installSource;
  if (canonical.bundleRefs === undefined && source.bundleRefs !== undefined) canonical.bundleRefs = source.bundleRefs;
  if (canonical.approvedPluginAccess === undefined && source.approvedPluginAccess !== undefined) {
    canonical.approvedPluginAccess = source.approvedPluginAccess;
  }
}

function migratePageindexRegistryEntries(
  entries: PluginRegistryEntry[],
): {
  plugins: PluginRegistryEntry[];
  migratedCount: number;
  removedDuplicateCount: number;
  defaultManifestPathMigrated: boolean;
} {
  const canonicalIndex = entries.findIndex((entry) => entry.id === LOCAL_INDEXER_PLUGIN_ID);
  const firstLegacyIndex = entries.findIndex((entry) => entry.id === PAGEINDEX_LEGACY_PLUGIN_ID);
  if (canonicalIndex === -1 && firstLegacyIndex === -1) {
    return { plugins: entries, migratedCount: 0, removedDuplicateCount: 0, defaultManifestPathMigrated: false };
  }

  const targetIndex = canonicalIndex === -1 ? firstLegacyIndex : canonicalIndex;
  const canonical = withLocalIndexerIdentity(entries[targetIndex]);
  let migratedCount = entries[targetIndex].id === PAGEINDEX_LEGACY_PLUGIN_ID ? 1 : 0;
  let defaultManifestPathMigrated =
    entries[targetIndex].manifestPath === PAGEINDEX_LEGACY_DEFAULT_MANIFEST_PATH
    && canonical.manifestPath === LOCAL_INDEXER_DEFAULT_MANIFEST_PATH;
  if (canonical.manifestPath !== entries[targetIndex].manifestPath) migratedCount += 1;
  let removedDuplicateCount = 0;

  for (let index = 0; index < entries.length; index += 1) {
    if (index === targetIndex) continue;
    const entry = entries[index];
    if (entry.id !== PAGEINDEX_LEGACY_PLUGIN_ID && entry.id !== LOCAL_INDEXER_PLUGIN_ID) continue;
    mergeMissingPageindexMetadata(canonical, entry);
    removedDuplicateCount += 1;
    if (entry.id === PAGEINDEX_LEGACY_PLUGIN_ID) migratedCount += 1;
    if (entry.manifestPath === PAGEINDEX_LEGACY_DEFAULT_MANIFEST_PATH) defaultManifestPathMigrated = true;
  }

  const plugins: PluginRegistryEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (index === targetIndex) {
      plugins.push(canonical);
      continue;
    }
    if (entry.id === PAGEINDEX_LEGACY_PLUGIN_ID || entry.id === LOCAL_INDEXER_PLUGIN_ID) continue;
    plugins.push(entry);
  }

  return { plugins, migratedCount, removedDuplicateCount, defaultManifestPathMigrated };
}

async function migratePageindexInstalledDirectory(
  registryPath: string,
  shouldAttemptMove: boolean,
): Promise<void> {
  if (!shouldAttemptMove) return;

  const registryDir = dirname(registryPath);
  const legacyDir = resolve(registryDir, PAGEINDEX_LEGACY_PLUGIN_ID);
  const canonicalDir = resolve(registryDir, LOCAL_INDEXER_PLUGIN_ID);

  if (!(await pathExists(legacyDir))) return;

  if (await pathExists(canonicalDir)) {
    plog(
      "warn",
      {
        pluginId: "<registry>",
        phase: PluginPhase.DISCOVERY_START,
        reason: "pageindex_plugin_dir_conflict",
        registryPath,
        legacyDir,
        canonicalDir,
      },
      "registry migrated pageindex default manifest to local-indexer but both plugin directories exist; keeping local-indexer and leaving pageindex untouched",
    );
    return;
  }

  try {
    await rename(legacyDir, canonicalDir);
    plog(
      "info",
      {
        pluginId: "<registry>",
        phase: PluginPhase.DISCOVERY_START,
        reason: "pageindex_plugin_dir_moved",
        registryPath,
        legacyDir,
        canonicalDir,
      },
      "moved installed pageindex plugin directory to local-indexer during registry migration",
    );
  } catch (err) {
    plog(
      "warn",
      {
        pluginId: "<registry>",
        phase: PluginPhase.DISCOVERY_FAIL,
        err,
        reason: "pageindex_plugin_dir_move_failed",
        registryPath,
        legacyDir,
        canonicalDir,
      },
      "failed to move pageindex plugin directory during registry migration",
    );
  }
}

/**
 * Map a legacy entry onto the new {@link PluginRegistryEntryInstallSource}
 * enum. Returns `null` when the entry already conforms (no migration
 * needed).
 *
 * Mapping:
 *   - `_devLinked === true`              → `installSource: "local-dev"`  (post-purge: was "dev-link")
 *   - else `installedBy === "admin"`     → `installSource: "admin"`
 *   - else `installedBy === "user"`      → `installSource: "user"`
 *   - existing `installSource: "dev-link"` → rewritten to `"local-dev"`
 *
 * Entries with neither legacy field (and no `installSource`) are migrated
 * by stripping the deprecated fields but leaving `installSource` undefined
 * — that preserves the deployment-guard's manifest-fallback behaviour for
 * registries that pre-date both fields.
 *
 * The deprecated fields are always stripped from the returned entry.
 *
 * `out.devLinkRewritten` is set to `true` when the migration crossed the
 * dev-link → local-dev boundary so the caller can emit a single-shot
 * audit warning. NO silent fallback — the operator must see the rewrite.
 */
function migrateLegacyEntry(
  entry: LegacyRegistryEntry,
  out: { devLinkRewritten: boolean },
): PluginRegistryEntry | null {
  const hasLegacy = entry.installedBy !== undefined || entry._devLinked !== undefined;
  const hasDevLinkInstallSource = entry.installSource === "dev-link";
  // Already-conformant entries (new shape, no dev-link, no legacy fields)
  // require no migration.
  if (!hasLegacy && !hasDevLinkInstallSource && entry.installSource !== undefined) return null;
  let installSource: PluginRegistryEntryInstallSource | undefined;
  if (hasDevLinkInstallSource || entry._devLinked === true) {
    installSource = "local-dev";
    out.devLinkRewritten = true;
  } else if (entry.installSource !== undefined) {
    installSource = entry.installSource as PluginRegistryEntryInstallSource;
  } else if (entry.installedBy === "admin") {
    installSource = "admin";
  } else if (entry.installedBy === "user") {
    installSource = "user";
  }
  // Build a fresh object that preserves only the supported fields.
  const migrated: PluginRegistryEntry = {
    id: entry.id,
    manifestPath: entry.manifestPath,
  };
  if (entry.enabled !== undefined) migrated.enabled = entry.enabled;
  if (entry.bundleRefs !== undefined) migrated.bundleRefs = entry.bundleRefs;
  if (entry.approvedPluginAccess !== undefined) migrated.approvedPluginAccess = entry.approvedPluginAccess;
  if (installSource !== undefined) migrated.installSource = installSource;
  return migrated;
}

export async function readPluginRegistry(registryPath: string): Promise<PluginRegistry> {
  plog("debug", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_START, registryPath }, "registry read");
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch (err) {
    // First-boot path: registry lives at `~/.lvis/plugins/registry.json`. On
    // a fresh dev or first-time install the file simply doesn't exist yet
    // — return the empty default so PluginRuntime.startAll can proceed and
    // the registry will be lazily created by the first install/uninstall.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      plog("info", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_SKIP, reason: "first_boot_no_registry" }, "no registry — first boot");
      return { version: 1, plugins: [] };
    }
    throw err;
  }
  let parsed: { version?: number; plugins?: LegacyRegistryEntry[] };
  try {
    parsed = JSON.parse(raw) as { version?: number; plugins?: LegacyRegistryEntry[] };
  } catch (err) {
    plog("error", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_FAIL, err, reason: "invalid_json", registryPath }, "registry parse failed");
    throw err;
  }
  if (!Array.isArray(parsed.plugins)) {
    plog("error", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_FAIL, reason: "invalid_format", registryPath }, "registry malformed");
    throw new Error(`Invalid plugin registry: ${registryPath}`);
  }
  // Apply legacy → installSource migration on read. We persist the
  // migrated form back to disk in one shot so subsequent reads are
  // no-ops. This is idempotent: an already-migrated entry returns
  // `null` from migrateLegacyEntry and is left alone.
  let migratedCount = 0;
  const out = { devLinkRewritten: false };
  const plugins: PluginRegistryEntry[] = parsed.plugins.map((entry) => {
    const migrated = migrateLegacyEntry(entry, out);
    if (migrated !== null) {
      migratedCount += 1;
      return migrated;
    }
    return entry as PluginRegistryEntry;
  });
  const pageindexMigration = migratePageindexRegistryEntries(plugins);
  const registry: PluginRegistry = {
    version: parsed.version ?? 1,
    plugins: pageindexMigration.plugins,
  };
  await migratePageindexInstalledDirectory(registryPath, pageindexMigration.defaultManifestPathMigrated);
  if (out.devLinkRewritten) {
    // Loud one-shot audit warning. Existing dev-link entries cannot load
    // any longer (receipt verification now applies unconditionally) so
    // the operator MUST notice this rewrite — there is no silent fallback.
    plog(
      "warn",
      {
        pluginId: "<registry>",
        phase: PluginPhase.DISCOVERY_START,
        reason: "dev_link_install_source_removed",
        registryPath,
      },
      `registry contained dev-link entries — rewritten to installSource:"local-dev". `
        + `These plugins will fail to load until reinstalled via the marketplace `
        + `or 'lvis-cli install file://<path-to-dist.zip>'.`,
    );
  }
  if (pageindexMigration.migratedCount > 0 || pageindexMigration.removedDuplicateCount > 0) {
    plog(
      "info",
      {
        pluginId: "<registry>",
        phase: PluginPhase.DISCOVERY_START,
        reason: "pageindex_registry_entry_migrated",
        migratedCount: pageindexMigration.migratedCount,
        removedDuplicateCount: pageindexMigration.removedDuplicateCount,
        registryPath,
      },
      `registry migrated pageindex entries to local-indexer (migrated=${pageindexMigration.migratedCount}, removedDuplicates=${pageindexMigration.removedDuplicateCount})`,
    );
  }
  if (migratedCount > 0) {
    plog(
      "info",
      {
        pluginId: "<registry>",
        phase: PluginPhase.DISCOVERY_START,
        reason: "legacy_install_source_migrated",
        migratedCount,
        registryPath,
      },
      `registry migrated ${migratedCount} legacy entries (installedBy/_devLinked → installSource)`,
    );
  }
  if (migratedCount > 0 || pageindexMigration.migratedCount > 0 || pageindexMigration.removedDuplicateCount > 0) {
    try {
      await writePluginRegistry(registryPath, registry);
    } catch (err) {
      plog(
        "warn",
        {
          pluginId: "<registry>",
          phase: PluginPhase.DISCOVERY_FAIL,
          err,
          reason: "registry_migration_persist_failed",
          registryPath,
        },
        "failed to persist migrated registry — will retry on next read",
      );
    }
  }
  return registry;
}

export async function writePluginRegistry(registryPath: string, registry: PluginRegistry): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
}

export function resolveManifestPathsFromRegistry(
  registryPath: string,
  entries: PluginRegistryEntry[],
): string[] {
  const baseDir = dirname(registryPath);
  return entries
    .filter((entry) => entry.enabled !== false)
    .map((entry) => (isAbsolute(entry.manifestPath) ? entry.manifestPath : resolve(baseDir, entry.manifestPath)));
}

// ─── Phase 1.5 F-round §M1: in-process async mutex ──────────────────
//
// Serialize read-modify-write cycles on registry.json to prevent TOCTOU
// races between concurrent install / uninstall / disable paths. Keyed by
// registryPath so tests with tmp paths do not interfere with production.
// Scope is intentionally in-process only — cross-process locking is Phase 2+
// (requires file locks or IPC serialization).

const registryLocks = new Map<string, Promise<void>>();

export async function withRegistryLock<T>(
  registryPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(registryPath);
  const prev = registryLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  // Next acquirer chains off this turn's completion, regardless of success.
  registryLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Atomic read → mutate → write helper. Use this from any code path that
 * modifies the registry to ensure serialization with concurrent writers.
 *
 * Example:
 *   await updatePluginRegistry(path, (reg) => {
 *     const entry = reg.plugins.find(...);
 *     if (entry) entry.enabled = false;
 *   });
 */
export async function updatePluginRegistry(
  registryPath: string,
  mutator: (registry: PluginRegistry) => void | Promise<void>,
): Promise<void> {
  await withRegistryLock(registryPath, async () => {
    const registry = await readPluginRegistry(registryPath);
    await mutator(registry);
    await writePluginRegistry(registryPath, registry);
  });
}
