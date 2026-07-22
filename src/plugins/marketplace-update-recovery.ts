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
import { installReceiptPath, restoreInstallReceiptRaw } from "./plugin-install-receipt.js";
import type { PluginPaths } from "./plugin-paths.js";
import { readPluginRegistry, updatePluginRegistry } from "./registry.js";
import type { PluginRegistryEntry } from "./types.js";
import { canonicalJSON } from "./whitelist/canonical-json.js";

type PendingUpdate = NonNullable<PluginRegistryEntry["pendingUpdate"]>;

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

function manifestPath(paths: PluginPaths, entry: PluginRegistryEntry): string {
  return isAbsolute(entry.manifestPath)
    ? entry.manifestPath
    : resolve(dirname(paths.registryPath), entry.manifestPath);
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertRecoveryBackupPath(paths: PluginPaths, pluginId: string, pending: PendingUpdate): string {
  const backupDir = pending.recoveryBackupDir;
  if (!backupDir || !pending.recoveryBackupMode || !isWithin(paths.pluginsRoot, backupDir)) {
    throw new Error(`Invalid recovery backup metadata for plugin: ${pluginId}`);
  }
  const name = basename(backupDir);
  const resolvedBackupDir = resolve(backupDir);
  const localBackupRoot = resolve(paths.pluginsRoot, ".cache", "local-install-rollback");
  const validName = pending.recoveryBackupMode === "rename"
    ? dirname(resolvedBackupDir) === resolve(paths.pluginsRoot)
      && name.startsWith(`.${pluginId}.old-`)
    : name.startsWith(`${pluginId}-`)
      && dirname(resolvedBackupDir) === localBackupRoot;
  if (!validName) throw new Error(`Unsafe recovery backup path for plugin: ${pluginId}`);
  return resolvedBackupDir;
}

async function liveMatchesPrevious(paths: PluginPaths, entry: PluginRegistryEntry): Promise<boolean> {
  const pending = entry.pendingUpdate;
  if (!pending) return false;
  const rawManifest = await readNullable(manifestPath(paths, entry));
  const manifestHash = rawManifest === null ? null : sha256(rawManifest);
  if (manifestHash !== pending.previousManifestFileSha256) return false;
  const receiptRaw = await readNullable(installReceiptPath(paths.cacheRoot, entry.id));
  return receiptRaw === pending.previousReceiptRaw;
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
  const rawManifest = await readNullable(manifestPath(paths, expectedEntry));
  const receiptRaw = await readNullable(installReceiptPath(paths.cacheRoot, expectedEntry.id));
  const pendingUpdate: PendingUpdate = {
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
  return updatePluginRegistry(paths.registryPath, (registry) => {
    const entry = registry.plugins.find((candidate) => candidate.id === expectedEntry.id);
    if (!entry) throw new Error(`Plugin registry entry disappeared before update: ${expectedEntry.id}`);
    if (entry.pendingUpdate) throw new Error(`Plugin update already pending: ${expectedEntry.id}`);
    if (canonicalJSON(entry) !== canonicalJSON(expectedEntry)) {
      throw new Error(`Plugin registry entry changed before update: ${expectedEntry.id}`);
    }
    entry.pendingUpdate = pendingUpdate;
    return { ...entry, bundleRefs: entry.bundleRefs ? [...entry.bundleRefs] : undefined };
  });
}

export async function recoverPendingPluginUpdate(
  paths: PluginPaths,
  pluginId: string,
): Promise<"recovered" | "unresolved" | "absent"> {
  const registry = await readPluginRegistry(paths.registryPath);
  const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
  const pending = entry?.pendingUpdate;
  if (!entry || !pending) return "absent";

  if (await liveMatchesPrevious(paths, entry)) {
    if (pending.recoveryBackupDir) {
      const backupDir = assertRecoveryBackupPath(paths, pluginId, pending);
      await retryOnTransientFsLock(() => rm(backupDir, { recursive: true, force: true }));
    }
    await clearPendingUpdate(paths, pluginId, pending);
    return "recovered";
  }

  if (!pending.recoveryBackupDir) return "unresolved";
  const backupDir = assertRecoveryBackupPath(paths, pluginId, pending);
  const installDir = resolve(paths.pluginsRoot, pluginId);
  const backupManifest = resolve(backupDir, "plugin.json");
  const backupRaw = await readNullable(backupManifest);
  if ((backupRaw === null ? null : sha256(backupRaw)) !== pending.previousManifestFileSha256) {
    return "unresolved";
  }

  const receiptPath = installReceiptPath(paths.cacheRoot, pluginId);
  if (pending.previousReceiptRaw === null) await rm(receiptPath, { force: true });
  else await restoreInstallReceiptRaw(paths.cacheRoot, pluginId, pending.previousReceiptRaw);

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
    await retryOnTransientFsLock(() => rm(backupDir, { recursive: true, force: true }));
  }
  if (!await liveMatchesPrevious(paths, entry)) return "unresolved";
  await clearPendingUpdate(paths, pluginId, pending);
  return "recovered";
}

export async function recoverPendingPluginUpdates(paths: PluginPaths): Promise<{
  recovered: string[];
  unresolved: string[];
}> {
  const registry = await readPluginRegistry(paths.registryPath);
  const ids = registry.plugins.filter((entry) => entry.pendingUpdate).map((entry) => entry.id);
  const result = { recovered: [] as string[], unresolved: [] as string[] };
  for (const id of ids) {
    try {
      const outcome = await recoverPendingPluginUpdate(paths, id);
      if (outcome === "recovered") result.recovered.push(id);
      else if (outcome === "unresolved") result.unresolved.push(id);
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
