import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { InstallPolicy, PluginAccessSpec, PluginRegistry, PluginRegistryEntry, PluginRegistryEntryInstallSource } from "./types.js";
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

/**
 * Remove the retired `pluginAccess.plugins[].tools` grant from persisted
 * state while preserving event grants and approval scopes. Registry files are
 * user-owned JSON, so this narrows the runtime shape defensively even when an
 * old entry was written by a previous host version.
 */
export function stripLegacyPluginToolGrants(
  access: PluginAccessSpec | undefined,
): { access: PluginAccessSpec | undefined; changed: boolean } {
  if (!access || !Array.isArray(access.plugins)) return { access, changed: false };
  let changed = false;
  const plugins = access.plugins.map((target) => {
    const record = target as unknown as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, "tools")) return target;
    changed = true;
    const eventOnlyTarget = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "tools"),
    );
    return eventOnlyTarget as unknown as typeof target;
  });
  return {
    access: changed ? { ...access, plugins } : access,
    changed,
  };
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
 * Entries that are already conformant — no legacy fields, not a dev-link,
 * with or without `installSource` — need no migration and return `null`, so
 * the caller does not re-persist + log them on every read. For such entries
 * `installSource` is simply left undefined, preserving the deployment-guard's
 * manifest-fallback behaviour for registries that pre-date the field.
 *
 * When an entry DOES need migration, the deprecated fields are stripped from
 * the returned entry.
 *
 * `out.devLinkRewritten` is set to `true` when the migration crossed the
 * dev-link → local-dev boundary so the caller can emit a single-shot
 * audit warning. NO silent fallback — the operator must see the rewrite.
 */
function migrateLegacyEntry(
  entry: LegacyRegistryEntry,
  out: { devLinkRewritten: boolean; legacyToolGrantsRemoved: boolean },
): PluginRegistryEntry | null {
  const hasLegacy = entry.installedBy !== undefined || entry._devLinked !== undefined;
  const hasDevLinkInstallSource = entry.installSource === "dev-link";
  const cleanedAccess = stripLegacyPluginToolGrants(entry.approvedPluginAccess);
  // Already-conformant entries (new shape, no dev-link, no legacy fields)
  // require no migration — whether or not installSource is set. (An entry
  // with no derivable installSource was previously rebuilt into a structurally
  // identical object on every read, triggering a needless re-persist + log
  // each boot.)
  if (!hasLegacy && !hasDevLinkInstallSource && !cleanedAccess.changed) return null;
  if (cleanedAccess.changed) out.legacyToolGrantsRemoved = true;
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
  if (entry.manifestSha256 !== undefined) migrated.manifestSha256 = entry.manifestSha256;
  if (entry.enabled !== undefined) migrated.enabled = entry.enabled;
  if (entry.bundleRefs !== undefined) migrated.bundleRefs = entry.bundleRefs;
  if (cleanedAccess.access !== undefined) migrated.approvedPluginAccess = cleanedAccess.access;
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
  const out = { devLinkRewritten: false, legacyToolGrantsRemoved: false };
  const plugins: PluginRegistryEntry[] = parsed.plugins.map((entry) => {
    const migrated = migrateLegacyEntry(entry, out);
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
  if (migratedCount > 0) {
    if (out.legacyToolGrantsRemoved) {
      plog(
        "info",
        {
          pluginId: "<registry>",
          phase: PluginPhase.DISCOVERY_START,
          reason: "legacy_plugin_tool_grants_removed",
          registryPath,
        },
        "registry contained retired pluginAccess.tools grants — removed them and retained event grants",
      );
    }

    plog(
      "info",
      {
        pluginId: "<registry>",
        phase: PluginPhase.DISCOVERY_START,
        reason: "legacy_registry_migrated",
        migratedCount,
        registryPath,
      },
      `registry migrated ${migratedCount} legacy entries`,
    );
  }
  if (migratedCount > 0) {
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
  // Do NOT filter on entry.enabled here — inactive plugins (enabled=false) are
  // still loaded into memory; tool exposure is gated in PluginRuntime via
  // inactivePluginIds, not by skipping the manifest path. (#1176)
  return entries
    .map((entry) => (isAbsolute(entry.manifestPath) ? entry.manifestPath : resolve(baseDir, entry.manifestPath)));
}

// ─── In-process async mutex ──────────────────────────────────────────
//
// Serialize read-modify-write cycles on registry.json to prevent TOCTOU
// races between concurrent install / uninstall / disable paths. Keyed by
// registryPath so tests with tmp paths do not interfere with production.
// Scope is intentionally in-process only — cross-process locking
// (file locks or IPC serialization) is not yet implemented.

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
