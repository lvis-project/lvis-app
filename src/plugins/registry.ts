import { readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, isAbsolute, resolve } from "node:path";
import type { InstallPolicy, PluginAccessSpec, PluginRegistry, PluginRegistryEntry, PluginRegistryEntryInstallSource } from "./types.js";
import { plog, PluginPhase } from "./lifecycle-log.js";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { FileLockReleaseError, withFileLock } from "../lib/with-file-lock.js";

/**
 * Pre-PR #430 registry shape — `installedBy` ("admin"|"user") and
 * `_devLinked` (boolean) carried the install-source signal as two
 * orthogonal fields. PR #430 collapsed both into the single
 * `installSource` enum. {@link migrateLegacyEntry} maps the legacy
 * shape onto the new enum and strips the deprecated fields, and
 * {@link readPluginRegistry} migrates the legacy form in memory. Persistence
 * is explicit through {@link migratePluginRegistry}, which uses the same
 * transaction as every other registry mutation.
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
  const plugins = access.plugins.flatMap((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      changed = true;
      return [];
    }

    const record = target as unknown as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, "tools")) return [target];
    changed = true;
    const eventOnlyTarget = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "tools"),
    );
    return [eventOnlyTarget as unknown as typeof target];
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    plog("error", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_FAIL, err, reason: "invalid_json", registryPath }, "registry parse failed");
    throw err;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    plog("error", { pluginId: "<registry>", phase: PluginPhase.DISCOVERY_FAIL, reason: "invalid_format", registryPath }, "registry malformed");
    throw new Error(`Invalid plugin registry: ${registryPath}`);
  }
  if (parsed.version !== undefined && typeof parsed.version !== "number") {
    throw new Error(`Invalid plugin registry version: ${registryPath}`);
  }
  // Apply legacy → installSource migration in memory. Persistence is an
  // explicit transaction so a read can never overwrite a concurrent writer.
  let migratedCount = 0;
  const out = { devLinkRewritten: false, legacyToolGrantsRemoved: false };
  validateRawPluginRegistry(parsed, registryPath);
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
  validatePluginRegistry(registry, registryPath);
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
        + `or the development-only Settings > Plugin Config > Install from local folder flow.`,
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
  return registry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const REGISTRY_ENTRY_KEYS = new Set([
  "id", "manifestPath", "manifestSha256", "enabled", "bundleRefs",
  "approvedPluginAccess", "installSource",
]);
const LEGACY_REGISTRY_ENTRY_KEYS = new Set([...REGISTRY_ENTRY_KEYS, "installedBy", "_devLinked"]);

function validateRawPluginRegistry(value: Record<string, unknown>, registryPath: string): void {
  assertOnlyKeys(value, new Set(["version", "plugins"]), `plugin registry: ${registryPath}`);
  if (value.version !== undefined && value.version !== 1) {
    throw new Error(`Invalid plugin registry version: ${registryPath}`);
  }
  for (const entry of value.plugins as unknown[]) validateRegistryEntry(entry, registryPath, true);
}

function validateRegistryEntry(
  value: unknown,
  registryPath: string,
  allowLegacy: boolean,
): asserts value is LegacyRegistryEntry {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.manifestPath !== "string"
    || value.manifestPath.length === 0) {
    throw new Error(`Invalid plugin registry entry: ${registryPath}`);
  }
  assertOnlyKeys(
    value,
    allowLegacy ? LEGACY_REGISTRY_ENTRY_KEYS : REGISTRY_ENTRY_KEYS,
    `plugin registry entry '${value.id}'`,
  );
  if (value.manifestSha256 !== undefined && typeof value.manifestSha256 !== "string") {
    throw new Error(`Invalid plugin registry manifest hash: ${value.id}`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`Invalid plugin registry enabled flag: ${value.id}`);
  }
  if (value.bundleRefs !== undefined && !isStringArray(value.bundleRefs)) {
    throw new Error(`Invalid plugin registry bundle references: ${value.id}`);
  }
  if (value.installedBy !== undefined && value.installedBy !== "admin" && value.installedBy !== "user") {
    throw new Error(`Invalid legacy plugin registry installedBy: ${value.id}`);
  }
  if (value._devLinked !== undefined && typeof value._devLinked !== "boolean") {
    throw new Error(`Invalid legacy plugin registry _devLinked: ${value.id}`);
  }
  const allowedInstallSources = allowLegacy
    ? new Set(["admin", "user", "local-dev", "dev-link"])
    : new Set(["admin", "user", "local-dev"]);
  if (value.installSource !== undefined || Object.prototype.hasOwnProperty.call(value, "installSource")) {
    if (typeof value.installSource !== "string" || !allowedInstallSources.has(value.installSource)) {
      throw new Error(`Invalid plugin registry install source: ${value.id}`);
    }
  }
  if (value.approvedPluginAccess !== undefined) validatePluginAccess(value.approvedPluginAccess, value.id);
}

function validatePluginAccess(value: unknown, pluginId: string): void {
  if (!isRecord(value)) throw new Error(`Invalid plugin registry access grant: ${pluginId}`);
  assertOnlyKeys(value, new Set(["plugins", "agentApprovalScopes"]), `plugin access for '${pluginId}'`);
  if (!Array.isArray(value.plugins)) throw new Error(`Invalid plugin access targets: ${pluginId}`);
  for (const target of value.plugins) {
    // Explicitly support the historical null target and retired tools array;
    // migration removes both without accepting arbitrary malformed objects.
    if (target === null) continue;
    if (!isRecord(target) || typeof target.pluginId !== "string" || target.pluginId.length === 0) {
      throw new Error(`Invalid plugin access target: ${pluginId}`);
    }
    assertOnlyKeys(target, new Set(["pluginId", "events", "tools"]), `plugin access target for '${pluginId}'`);
    if (target.events !== undefined && !isStringArray(target.events)) {
      throw new Error(`Invalid plugin access events: ${pluginId}`);
    }
    if (target.tools !== undefined && !isStringArray(target.tools)) {
      throw new Error(`Invalid legacy plugin access tools: ${pluginId}`);
    }
  }
  if (value.agentApprovalScopes !== undefined && !isStringArray(value.agentApprovalScopes)) {
    throw new Error(`Invalid plugin approval scopes: ${pluginId}`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, context: string): void {
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`Unsupported ${context} field: ${unsupported}`);
}

function validatePluginRegistry(registry: PluginRegistry, registryPath: string): void {
  if (registry.version !== 1 || !Array.isArray(registry.plugins)) {
    throw new Error(`Invalid plugin registry: ${registryPath}`);
  }
  const ids = new Set<string>();
  for (const entry of registry.plugins) {
    validateRegistryEntry(entry, registryPath, false);
    if (ids.has(entry.id)) throw new Error(`Duplicate plugin registry entry: ${entry.id}`);
    ids.add(entry.id);
  }
}

function canonicalizePluginRegistry(registry: PluginRegistry): PluginRegistry {
  return {
    version: registry.version,
    plugins: [...registry.plugins].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
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
// Serialize in-process contenders before acquiring the cross-process lock.
// The lock target is a stable sibling anchor: withFileLock may create its
// target, so it must never point at registry.json (a missing registry means
// empty state, while an empty registry file is corruption).

const registryLocks = new Map<string, Promise<void>>();
const registryMutationContext = new AsyncLocalStorage<ReadonlySet<string>>();

async function withRegistryTransaction<T>(
  registryPath: string,
  mutator: (registry: PluginRegistry) => T,
): Promise<T> {
  const key = resolve(registryPath);
  const prev = registryLocks.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const committed = await withFileLock(
        `${key}.lock-anchor`,
        async () => {
          const registry = await readPluginRegistry(key);
          const inherited = registryMutationContext.getStore() ?? new Set<string>();
          const result = registryMutationContext.run(
            new Set([...inherited, key]),
            () => mutator(registry),
          );
          if (result !== null
            && (typeof result === "object" || typeof result === "function")
            && typeof (result as { then?: unknown }).then === "function") {
            void Promise.resolve(result).catch(() => undefined);
            throw new Error("Plugin registry mutator must be synchronous");
          }
          validatePluginRegistry(registry, key);
          const canonical = canonicalizePluginRegistry(registry);
          const content = `${JSON.stringify(canonical, null, 2)}\n`;
          try {
            writeUtf8FileAtomicSync(key, content, 0o600);
          } catch (error) {
            if (!isCommittedAtomicWriteError(error)) throw error;
            const persisted = await readFile(key, "utf-8");
            if (persisted !== content) throw error;
            plog(
              "warn",
              {
                pluginId: "<registry>",
                phase: PluginPhase.DISCOVERY_FAIL,
                reason: "registry_atomic_commit_sync_unconfirmed",
                registryPath: key,
              },
              "registry atomic rename committed; exact bytes verified after parent directory sync failure",
            );
          }
          return { content, mutationResult: result };
        },
      );
      return committed.mutationResult;
    } catch (error) {
      if (!(error instanceof FileLockReleaseError)) throw error;
      const committed = error.result as { content: string; mutationResult: T };
      const persisted = await readFile(key, "utf-8");
      if (persisted !== committed.content) throw error;
      plog(
        "warn",
        {
          pluginId: "<registry>",
          phase: PluginPhase.DISCOVERY_FAIL,
          err: error.releaseError,
          reason: "registry_lock_release_failed_after_commit",
          registryPath: key,
        },
        "registry commit completed but lock release failed; exact bytes verified and stale-lock recovery may be required",
      );
      return committed.mutationResult;
    }
  });
  // Next acquirer chains off this turn's completion, regardless of success.
  const tail = next.then(() => undefined, () => undefined);
  registryLocks.set(key, tail);
  try {
    return await next;
  } finally {
    if (registryLocks.get(key) === tail) registryLocks.delete(key);
  }
}

function isCommittedAtomicWriteError(error: unknown): error is Error & { committed: true } {
  return error instanceof Error && (error as { committed?: unknown }).committed === true;
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
export function updatePluginRegistry<T = void>(
  registryPath: string,
  mutator: (registry: PluginRegistry) => T,
): Promise<T> {
  if ((registryMutationContext.getStore()?.size ?? 0) > 0) {
    throw new Error("Nested plugin registry mutation is not allowed");
  }
  return withRegistryTransaction(registryPath, mutator);
}

/** Persist any in-memory legacy migration through the registry transaction. */
export function migratePluginRegistry(registryPath: string): Promise<void> {
  return updatePluginRegistry(registryPath, () => undefined);
}
