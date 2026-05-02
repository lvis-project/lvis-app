import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 */
interface LegacyRegistryEntry extends PluginRegistryEntry {
  installedBy?: InstallPolicy;
  _devLinked?: boolean;
}

/**
 * Map a legacy entry onto the new {@link PluginRegistryEntryInstallSource}
 * enum. Returns `null` when the entry already conforms (no migration
 * needed).
 *
 * Mapping (matches the disjunction other call sites used pre-cleanup):
 *   - `_devLinked === true`        → `installSource: "dev-link"`
 *   - else `installedBy === "admin"` → `installSource: "admin"`
 *   - else `installedBy === "user"` → `installSource: "user"`
 *
 * Entries with neither legacy field (and no `installSource`) are migrated
 * by stripping the deprecated fields but leaving `installSource` undefined
 * — that preserves the deployment-guard's manifest-fallback behaviour for
 * registries that pre-date both fields.
 *
 * The deprecated fields are always stripped from the returned entry.
 */
function migrateLegacyEntry(entry: LegacyRegistryEntry): PluginRegistryEntry | null {
  const hasLegacy = entry.installedBy !== undefined || entry._devLinked !== undefined;
  if (!hasLegacy && entry.installSource !== undefined) return null;
  let installSource: PluginRegistryEntryInstallSource | undefined = entry.installSource;
  if (installSource === undefined) {
    if (entry._devLinked === true) {
      installSource = "dev-link";
    } else if (entry.installedBy === "admin") {
      installSource = "admin";
    } else if (entry.installedBy === "user") {
      installSource = "user";
    }
    // No legacy signal at all → leave installSource undefined so the
    // deployment-guard manifest-fallback path still fires.
  }
  if (!hasLegacy && installSource === entry.installSource) return null;
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
  const plugins: PluginRegistryEntry[] = parsed.plugins.map((entry) => {
    const migrated = migrateLegacyEntry(entry);
    if (migrated !== null) {
      migratedCount += 1;
      return migrated;
    }
    return entry as PluginRegistryEntry;
  });
  const registry: PluginRegistry = {
    version: parsed.version ?? 1,
    plugins,
  };
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
    try {
      await writePluginRegistry(registryPath, registry);
    } catch (err) {
      plog(
        "warn",
        {
          pluginId: "<registry>",
          phase: PluginPhase.DISCOVERY_FAIL,
          err,
          reason: "legacy_migration_persist_failed",
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
