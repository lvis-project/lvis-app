/**
 * Durable marketplace/local replacement recovery.
 *
 * Ownership and removal contract:
 * - the replacement transaction owns `registryEntry.pendingUpdate` from the
 *   final pre-promotion boundary until its registry commit succeeds;
 * - boot or an explicit service retry may clear it only when the old live
 *   manifest + receipt still match exactly, or after restoring the validated
 *   recorded backup and old receipt;
 * - recovery backups remain outside `+tombstones+` and are never swept while
 *   unresolved; explicit cleanup may delete the backup metadata but leaves the
 *   row pending/hidden until a verified reinstall publishes a new row;
 * - only obsolete backups from an already-successful commit enter the existing
 *   tombstone/sweeper lifecycle.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { retryOnTransientFsLock } from "./plugin-artifact-store.js";
import {
  installReceiptPath,
  restoreInstallReceiptRaw,
  verifyInstallReceipt,
  verifyInstallReceiptRaw,
} from "./plugin-install-receipt.js";
import type { PluginPaths } from "./plugin-paths.js";
import { readPluginRegistry, updatePluginRegistry } from "./registry.js";
import type { PluginRegistryEntry } from "./types.js";
import { canonicalJSON } from "./whitelist/canonical-json.js";
import { assertSafeArtifactSlug } from "./plugin-id.js";

type PendingUpdate = NonNullable<PluginRegistryEntry["pendingUpdate"]>;
type PendingCleanup = NonNullable<PluginRegistryEntry["pendingCleanup"]>[number];

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function readNullable(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function ownedInstallDir(paths: PluginPaths, pluginId: string): string {
  return resolve(paths.pluginsRoot, assertSafeArtifactSlug(pluginId));
}

function ownedManifestPath(paths: PluginPaths, pluginId: string): string {
  return resolve(ownedInstallDir(paths, pluginId), "plugin.json");
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertOwnedBackupPath(
  paths: PluginPaths,
  pluginId: string,
  backupDir: string | undefined,
  mode: "rename" | "copy" | undefined,
): string {
  const safePluginId = assertSafeArtifactSlug(pluginId);
  if (!backupDir || !mode || !isWithin(paths.pluginsRoot, backupDir)) {
    throw new Error(`Invalid recovery backup metadata for plugin: ${pluginId}`);
  }
  const name = basename(backupDir);
  const resolvedBackupDir = resolve(backupDir);
  const localBackupRoot = resolve(paths.pluginsRoot, ".cache", "local-install-rollback");
  const escapedPluginId = safePluginId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marketplaceName = new RegExp(
    `^\\.${escapedPluginId}\\.old-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "i",
  );
  const localName = new RegExp(`^${escapedPluginId}-[0-9]+-[0-9]+$`);
  const validName = mode === "rename"
    ? dirname(resolvedBackupDir) === resolve(paths.pluginsRoot)
      && marketplaceName.test(name)
    : dirname(resolvedBackupDir) === localBackupRoot
      && localName.test(name);
  if (!validName) throw new Error(`Unsafe recovery backup path for plugin: ${pluginId}`);
  return resolvedBackupDir;
}

function assertRecoveryBackupPath(paths: PluginPaths, pluginId: string, pending: PendingUpdate): string {
  return assertOwnedBackupPath(
    paths,
    pluginId,
    pending.recoveryBackupDir,
    pending.recoveryBackupMode,
  );
}

function cleanupRecordForBackup(pending: Pick<PendingUpdate, "recoveryBackupDir" | "recoveryBackupMode">): PendingCleanup | null {
  if (!pending.recoveryBackupDir || !pending.recoveryBackupMode) return null;
  return {
    kind: pending.recoveryBackupMode === "rename" ? "obsolete-artifact" : "obsolete-local-backup",
    path: resolve(pending.recoveryBackupDir),
  };
}

function appendPendingCleanup(entry: PluginRegistryEntry, cleanup: PendingCleanup | null): void {
  if (!cleanup) return;
  const existing = entry.pendingCleanup ?? [];
  if (existing.some((item) => resolve(item.path) === cleanup.path)) return;
  entry.pendingCleanup = [...existing.map((item) => ({ ...item })), cleanup];
}

export function pendingOwnedBackupPaths(paths: PluginPaths, entry: PluginRegistryEntry): string[] {
  const owned = new Set<string>();
  if (entry.pendingUpdate?.recoveryBackupDir) {
    owned.add(assertRecoveryBackupPath(paths, entry.id, entry.pendingUpdate));
  }
  for (const cleanup of entry.pendingCleanup ?? []) {
    owned.add(assertPendingCleanupPath(paths, entry.id, cleanup));
  }
  return [...owned];
}

async function payloadMatchesPrevious(
  entry: PluginRegistryEntry,
  pluginRoot: string,
): Promise<boolean> {
  const pending = entry.pendingUpdate;
  if (!pending || pending.previousReceiptRaw === null) return false;
  const rawManifest = await readNullable(resolve(pluginRoot, "plugin.json"));
  const manifestHash = rawManifest === null ? null : sha256(rawManifest);
  if (manifestHash !== pending.previousManifestFileSha256) return false;
  return (await verifyInstallReceiptRaw(pending.previousReceiptRaw, entry.id, pluginRoot)).ok;
}

async function liveMatchesPrevious(paths: PluginPaths, entry: PluginRegistryEntry): Promise<boolean> {
  const pending = entry.pendingUpdate;
  if (!pending || !await payloadMatchesPrevious(entry, ownedInstallDir(paths, entry.id))) return false;
  const receiptRaw = await readNullable(installReceiptPath(paths.cacheRoot, entry.id));
  if (receiptRaw !== pending.previousReceiptRaw) return false;
  return (await verifyInstallReceipt(paths.cacheRoot, entry.id, ownedInstallDir(paths, entry.id))).ok;
}

async function clearPendingUpdate(paths: PluginPaths, pluginId: string, expected: PendingUpdate): Promise<void> {
  await updatePluginRegistry(paths.registryPath, (registry) => {
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (!entry?.pendingUpdate || JSON.stringify(entry.pendingUpdate) !== JSON.stringify(expected)) {
      throw new Error(`Pending plugin update changed during recovery: ${pluginId}`);
    }
    entry.pendingUpdate = undefined;
  });
}

export async function preparePendingPluginUpdate(
  paths: PluginPaths,
  expectedEntry: PluginRegistryEntry,
  options: {
    kind: PendingUpdate["kind"];
    recoveryBackupDir?: string;
    recoveryBackupMode?: NonNullable<PendingUpdate["recoveryBackupMode"]>;
  },
): Promise<PluginRegistryEntry> {
  assertSafeArtifactSlug(expectedEntry.id);
  const pendingUpdate = expectedEntry.pendingUpdate
    ? null
    : await (async (): Promise<PendingUpdate> => {
        const rawManifest = await readNullable(ownedManifestPath(paths, expectedEntry.id));
        const receiptRaw = await readNullable(installReceiptPath(paths.cacheRoot, expectedEntry.id));
        return {
          kind: options.kind,
          previousManifestFileSha256: rawManifest === null ? null : sha256(rawManifest),
          previousReceiptRaw: receiptRaw,
          ...(options.recoveryBackupDir && options.recoveryBackupMode
            ? {
                recoveryBackupDir: resolve(options.recoveryBackupDir),
                recoveryBackupMode: options.recoveryBackupMode,
              }
            : {}),
        };
      })();
  return updatePluginRegistry(paths.registryPath, (registry) => {
    const entry = registry.plugins.find((candidate) => candidate.id === expectedEntry.id);
    if (!entry) throw new Error(`Plugin registry entry disappeared before update: ${expectedEntry.id}`);
    if (canonicalJSON(entry) !== canonicalJSON(expectedEntry)) {
      throw new Error(`Plugin registry entry changed before update: ${expectedEntry.id}`);
    }
    if (entry.pendingUpdate) {
      // A verified retry never snapshots unresolved live bytes as a predecessor.
      // Keep the original recovery contract intact and journal the retry's
      // immediate backup as cleanup-only ownership before promotion can occur.
      appendPendingCleanup(entry, cleanupRecordForBackup({
        recoveryBackupDir: options.recoveryBackupDir,
        recoveryBackupMode: options.recoveryBackupMode,
      }));
    } else {
      entry.pendingUpdate = pendingUpdate!;
    }
    return {
      ...entry,
      bundleRefs: entry.bundleRefs ? [...entry.bundleRefs] : undefined,
      pendingUpdate: entry.pendingUpdate ? { ...entry.pendingUpdate } : undefined,
      pendingCleanup: entry.pendingCleanup?.map((item) => ({ ...item })),
    };
  });
}

export async function recoverPendingPluginUpdate(
  paths: PluginPaths,
  pluginId: string,
): Promise<"recovered" | "unresolved" | "absent"> {
  assertSafeArtifactSlug(pluginId);
  const registry = await readPluginRegistry(paths.registryPath);
  const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
  const pending = entry?.pendingUpdate;
  if (!entry || !pending) return "absent";

  const installDir = ownedInstallDir(paths, pluginId);
  if (await payloadMatchesPrevious(entry, installDir)) {
    if (pending.previousReceiptRaw === null) return "unresolved";
    if (await readNullable(installReceiptPath(paths.cacheRoot, pluginId)) !== pending.previousReceiptRaw) {
      await restoreInstallReceiptRaw(paths.cacheRoot, pluginId, pending.previousReceiptRaw);
    }
    if (!await liveMatchesPrevious(paths, entry)) return "unresolved";
    if (pending.recoveryBackupDir) {
      const backupDir = assertRecoveryBackupPath(paths, pluginId, pending);
      await retryOnTransientFsLock(() => rm(backupDir, { recursive: true, force: true }));
    }
    await clearPendingUpdate(paths, pluginId, pending);
    return "recovered";
  }

  if (!pending.recoveryBackupDir) return "unresolved";
  const backupDir = assertRecoveryBackupPath(paths, pluginId, pending);
  if (!await payloadMatchesPrevious(entry, backupDir)) {
    return "unresolved";
  }

  await retryOnTransientFsLock(() => rm(installDir, { recursive: true, force: true }));
  if (pending.recoveryBackupMode === "rename") {
    await retryOnTransientFsLock(() => rename(backupDir, installDir));
  } else {
    const restoreStage = `${installDir}.recovery-${process.pid}-${Date.now()}`;
    await rm(restoreStage, { recursive: true, force: true });
    await mkdir(dirname(restoreStage), { recursive: true });
    try {
      await cp(backupDir, restoreStage, { recursive: true, verbatimSymlinks: true });
      await retryOnTransientFsLock(() => rename(restoreStage, installDir));
    } catch (error) {
      await rm(restoreStage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  if (pending.previousReceiptRaw === null) return "unresolved";
  await restoreInstallReceiptRaw(paths.cacheRoot, pluginId, pending.previousReceiptRaw);
  if (!await liveMatchesPrevious(paths, entry)) return "unresolved";
  if (pending.recoveryBackupMode === "copy") {
    await retryOnTransientFsLock(() => rm(backupDir, { recursive: true, force: true }));
  }
  await clearPendingUpdate(paths, pluginId, pending);
  return "recovered";
}

export async function restoreSupersededPendingPluginUpdate(
  paths: PluginPaths,
  expectedCurrent: PluginRegistryEntry,
  previousEntry: PluginRegistryEntry,
  options: { preserveRetryCleanup?: boolean } = {},
): Promise<void> {
  if (!expectedCurrent.pendingUpdate || !previousEntry.pendingUpdate || previousEntry.id !== expectedCurrent.id) {
    throw new Error(`Invalid superseded pending update restore: ${previousEntry.id}`);
  }
  assertSafeArtifactSlug(previousEntry.id);
  await updatePluginRegistry(paths.registryPath, (registry) => {
    const current = registry.plugins.find((candidate) => candidate.id === previousEntry.id);
    if (!current?.pendingUpdate
      || canonicalJSON(current.pendingUpdate) !== canonicalJSON(expectedCurrent.pendingUpdate)) {
      throw new Error(`Pending plugin update changed during reinstall rollback: ${previousEntry.id}`);
    }
    current.pendingUpdate = { ...previousEntry.pendingUpdate! };
    if (!options.preserveRetryCleanup) {
      current.pendingCleanup = previousEntry.pendingCleanup?.map((item) => ({ ...item }));
    }
  });
}

function assertPendingCleanupPath(paths: PluginPaths, pluginId: string, pending: PendingCleanup): string {
  return assertOwnedBackupPath(
    paths,
    pluginId,
    pending.path,
    pending.kind === "obsolete-artifact" ? "rename" : "copy",
  );
}

export async function cleanupObsoletePluginBackup(paths: PluginPaths, pluginId: string): Promise<boolean> {
  assertSafeArtifactSlug(pluginId);
  let cleaned = false;
  while (true) {
    const registry = await readPluginRegistry(paths.registryPath);
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    const expected = entry?.pendingCleanup?.[0];
    if (!entry || !expected) return cleaned;
    const expectedPath = assertPendingCleanupPath(paths, pluginId, expected);
    await retryOnTransientFsLock(() => rm(expectedPath, { recursive: true, force: true }));
    await clearObsoletePluginBackupOwnership(paths, pluginId, expectedPath);
    cleaned = true;
  }
}

export async function cleanupObsoletePluginBackupPath(
  paths: PluginPaths,
  pluginId: string,
  obsoleteDir: string,
): Promise<boolean> {
  assertSafeArtifactSlug(pluginId);
  const registry = await readPluginRegistry(paths.registryPath);
  const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
  const target = entry?.pendingCleanup?.find((item) => resolve(item.path) === resolve(obsoleteDir));
  if (!target) return false;
  const targetPath = assertPendingCleanupPath(paths, pluginId, target);
  await retryOnTransientFsLock(() => rm(targetPath, { recursive: true, force: true }));
  await clearObsoletePluginBackupOwnership(paths, pluginId, targetPath);
  return true;
}

export async function clearObsoletePluginBackupOwnership(
  paths: PluginPaths,
  pluginId: string,
  obsoleteDir: string,
): Promise<void> {
  assertSafeArtifactSlug(pluginId);
  await updatePluginRegistry(paths.registryPath, (registry) => {
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (!entry?.pendingCleanup) return;
    const remaining = entry.pendingCleanup.filter((item) => resolve(item.path) !== resolve(obsoleteDir));
    entry.pendingCleanup = remaining.length > 0 ? remaining : undefined;
  });
}

export async function recoverPendingPluginUpdates(paths: PluginPaths): Promise<{
  recovered: string[];
  unresolved: string[];
}> {
  const registry = await readPluginRegistry(paths.registryPath);
  const ids = registry.plugins
    .filter((entry) => entry.pendingUpdate || (entry.pendingCleanup?.length ?? 0) > 0)
    .map((entry) => entry.id);
  const result = { recovered: [] as string[], unresolved: [] as string[] };
  for (const id of ids) {
    try {
      const outcome = await recoverPendingPluginUpdate(paths, id);
      const cleaned = await cleanupObsoletePluginBackup(paths, id);
      if (outcome === "unresolved") result.unresolved.push(id);
      else if (outcome === "recovered" || cleaned) result.recovered.push(id);
    } catch {
      result.unresolved.push(id);
    }
  }
  return result;
}

export async function cleanupPendingPluginUpdateBackup(paths: PluginPaths, pluginId: string): Promise<boolean> {
  const registry = await readPluginRegistry(paths.registryPath);
  const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
  const pending = entry?.pendingUpdate;
  if (!pending?.recoveryBackupDir) return false;
  const backupDir = assertRecoveryBackupPath(paths, pluginId, pending);
  await retryOnTransientFsLock(() => rm(backupDir, { recursive: true, force: true }));
  await updatePluginRegistry(paths.registryPath, (fresh) => {
    const current = fresh.plugins.find((candidate) => candidate.id === pluginId);
    if (!current?.pendingUpdate) return;
    current.pendingUpdate = {
      kind: current.pendingUpdate.kind,
      previousManifestFileSha256: current.pendingUpdate.previousManifestFileSha256,
      previousReceiptRaw: current.pendingUpdate.previousReceiptRaw,
    };
  });
  return true;
}
