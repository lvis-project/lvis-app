import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { retryOnTransientFsLock } from "./plugin-artifact-store.js";
import { assertSafeArtifactSlug } from "./plugin-id.js";
import type { PluginPaths } from "./plugin-paths.js";
import { readPluginRegistry, validatePluginRegistryEntries } from "./registry.js";
import type { PluginRegistryEntry } from "./types.js";
import { canonicalJSON } from "./whitelist/canonical-json.js";
import { pendingOwnedBackupPaths } from "./marketplace-update-recovery.js";

const TRANSACTION_ROOT = "+transactions+";
const REMOVAL_SUBDIR = "removals";
const JOURNAL_FILE = "journal.json";
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_TRANSACTION_ENTRIES = 256;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RemovalTransactionKind = "uninstall" | "install-rollback" | "quarantine";
export type RemovalTransactionPhase = "staging" | "registry-committed";

export interface RemovalTransactionMapping {
  pluginId: string;
  originalPath: string;
  stagedPath: string;
}

export interface RemovalTransactionJournal {
  schemaVersion: 1;
  transactionId: string;
  kind: RemovalTransactionKind;
  phase: RemovalTransactionPhase;
  pluginIds: string[];
  registryBefore: PluginRegistryEntry[];
  registryAfter: PluginRegistryEntry[];
  mappings: RemovalTransactionMapping[];
}

export interface ReconcileOptions {
  renamePath?: typeof rename;
  retry?: Parameters<typeof retryOnTransientFsLock>[1];
}

export interface RemovalTransactionFailure {
  transactionId: string;
  reason: string;
}

export interface RemovalTransactionReconciliationResult {
  restored: string[];
  cleaned: string[];
  unresolved: RemovalTransactionFailure[];
}

function transactionRoot(paths: PluginPaths): string {
  return resolve(paths.pluginsRoot, TRANSACTION_ROOT, REMOVAL_SUBDIR);
}

function transactionDir(paths: PluginPaths, transactionId: string): string {
  return resolve(transactionRoot(paths), transactionId);
}

function journalPath(paths: PluginPaths, transactionId: string): string {
  return resolve(transactionDir(paths, transactionId), JOURNAL_FILE);
}

async function assertRealDirectory(path: string, expectedCanonicalPath: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== expectedCanonicalPath) {
    throw new Error(`Unsafe removal transaction ${label}`);
  }
}

async function canonicalPluginsRoot(paths: PluginPaths): Promise<string> {
  const info = await lstat(paths.pluginsRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Unsafe removal transaction plugins root");
  }
  return realpath(paths.pluginsRoot);
}

async function assertOwnedTransactionRoot(paths: PluginPaths): Promise<string> {
  const canonicalRoot = await canonicalPluginsRoot(paths);
  const namespaceDir = resolve(paths.pluginsRoot, TRANSACTION_ROOT);
  const root = transactionRoot(paths);
  await assertRealDirectory(namespaceDir, resolve(canonicalRoot, TRANSACTION_ROOT), "namespace");
  await assertRealDirectory(root, resolve(canonicalRoot, TRANSACTION_ROOT, REMOVAL_SUBDIR), "root");
  return canonicalRoot;
}

async function ensureOwnedDirectory(path: string, expectedCanonicalPath: string, label: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertRealDirectory(path, expectedCanonicalPath, label);
}

async function createOwnedTransactionDirectory(paths: PluginPaths, transactionId: string): Promise<void> {
  const canonicalRoot = await canonicalPluginsRoot(paths);
  const namespaceDir = resolve(paths.pluginsRoot, TRANSACTION_ROOT);
  const removalsDir = transactionRoot(paths);
  const txDir = transactionDir(paths, transactionId);
  await ensureOwnedDirectory(namespaceDir, resolve(canonicalRoot, TRANSACTION_ROOT), "namespace");
  await assertRealDirectory(namespaceDir, resolve(canonicalRoot, TRANSACTION_ROOT), "namespace");
  await ensureOwnedDirectory(removalsDir, resolve(canonicalRoot, TRANSACTION_ROOT, REMOVAL_SUBDIR), "root");
  await assertOwnedTransactionRoot(paths);
  await ensureOwnedDirectory(txDir, resolve(canonicalRoot, TRANSACTION_ROOT, REMOVAL_SUBDIR, transactionId), "directory");
  await assertRealDirectory(
    txDir,
    resolve(canonicalRoot, TRANSACTION_ROOT, REMOVAL_SUBDIR, transactionId),
    "directory",
  );
  await ensureOwnedDirectory(
    resolve(txDir, "staged"),
    resolve(canonicalRoot, TRANSACTION_ROOT, REMOVAL_SUBDIR, transactionId, "staged"),
    "staged directory",
  );
}

async function assertOwnedTransactionDirectory(paths: PluginPaths, transactionId: string): Promise<void> {
  const canonicalRoot = await assertOwnedTransactionRoot(paths);
  const txDir = transactionDir(paths, transactionId);
  const stagedDir = resolve(txDir, "staged");
  await assertRealDirectory(
    txDir,
    resolve(canonicalRoot, TRANSACTION_ROOT, REMOVAL_SUBDIR, transactionId),
    "directory",
  );
  await assertRealDirectory(
    stagedDir,
    resolve(canonicalRoot, TRANSACTION_ROOT, REMOVAL_SUBDIR, transactionId, "staged"),
    "staged directory",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Invalid ${label} keys`);
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneEntry(entry: PluginRegistryEntry): PluginRegistryEntry {
  return JSON.parse(JSON.stringify(entry)) as PluginRegistryEntry;
}

function canonicalManifestPath(paths: PluginPaths, pluginId: string): string {
  return resolve(paths.pluginsRoot, pluginId, "plugin.json");
}

export function assertCanonicalRegistryOwnership(paths: PluginPaths, entry: PluginRegistryEntry): string {
  const pluginId = assertSafeArtifactSlug(entry.id);
  const resolvedManifest = isAbsolute(entry.manifestPath)
    ? resolve(entry.manifestPath)
    : resolve(dirname(paths.registryPath), entry.manifestPath);
  const expectedManifest = canonicalManifestPath(paths, pluginId);
  if (resolvedManifest !== expectedManifest || dirname(resolvedManifest) !== resolve(paths.pluginsRoot, pluginId)) {
    throw new Error(`Registry ownership mismatch for plugin '${pluginId}'`);
  }
  return dirname(expectedManifest);
}

function validateProjectionEntry(value: unknown, paths: PluginPaths): PluginRegistryEntry {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.manifestPath !== "string") {
    throw new Error("Invalid removal transaction registry projection");
  }
  const entry = value as unknown as PluginRegistryEntry;
  assertCanonicalRegistryOwnership(paths, entry);
  return entry;
}

function assertJournal(paths: PluginPaths, value: unknown, expectedTransactionId: string): RemovalTransactionJournal {
  if (!isRecord(value)) throw new Error("Invalid removal transaction journal");
  assertOnlyKeys(value, [
    "schemaVersion", "transactionId", "kind", "phase", "pluginIds",
    "registryBefore", "registryAfter", "mappings",
  ], "removal transaction journal");
  if (value.schemaVersion !== 1
    || typeof value.transactionId !== "string"
    || value.transactionId !== expectedTransactionId
    || !UUID_RE.test(value.transactionId)
    || (value.kind !== "uninstall" && value.kind !== "install-rollback" && value.kind !== "quarantine")
    || (value.phase !== "staging" && value.phase !== "registry-committed")
    || !Array.isArray(value.pluginIds)
    || !Array.isArray(value.registryBefore)
    || !Array.isArray(value.registryAfter)
    || !Array.isArray(value.mappings)
    || value.pluginIds.length === 0
    || value.pluginIds.length > MAX_TRANSACTION_ENTRIES
    || value.mappings.length > MAX_TRANSACTION_ENTRIES) {
    throw new Error("Invalid removal transaction journal schema");
  }

  const pluginIds = value.pluginIds.map((id) => assertSafeArtifactSlug(id));
  if (new Set(pluginIds).size !== pluginIds.length) throw new Error("Duplicate removal transaction plugin id");
  validatePluginRegistryEntries(value.registryBefore, "removal transaction registryBefore");
  validatePluginRegistryEntries(value.registryAfter, "removal transaction registryAfter");
  const before = value.registryBefore.map((entry) => validateProjectionEntry(entry, paths));
  const after = value.registryAfter.map((entry) => validateProjectionEntry(entry, paths));
  const projectedIds = new Set([...before, ...after].map((entry) => entry.id));
  if (projectedIds.size !== pluginIds.length || pluginIds.some((id) => !projectedIds.has(id))) {
    throw new Error("Removal transaction projection does not match plugin ids");
  }

  const txDir = transactionDir(paths, expectedTransactionId);
  const stagedDir = resolve(txDir, "staged");
  const allowedOriginals = new Map<string, Set<string>>();
  for (const entry of before) {
    const allowed = new Set<string>([assertCanonicalRegistryOwnership(paths, entry)]);
    for (const path of pendingOwnedBackupPaths(paths, entry)) allowed.add(resolve(path));
    allowedOriginals.set(entry.id, allowed);
  }
  const originals = new Set<string>();
  const staged = new Set<string>();
  const mappings = value.mappings.map((mapping, index): RemovalTransactionMapping => {
    if (!isRecord(mapping)) throw new Error("Invalid removal transaction mapping");
    assertOnlyKeys(mapping, ["pluginId", "originalPath", "stagedPath"], "removal transaction mapping");
    if (typeof mapping.pluginId !== "string"
      || typeof mapping.originalPath !== "string"
      || typeof mapping.stagedPath !== "string") {
      throw new Error("Invalid removal transaction mapping");
    }
    const pluginId = assertSafeArtifactSlug(mapping.pluginId);
    const originalPath = resolve(mapping.originalPath);
    const stagedPath = resolve(mapping.stagedPath);
    const expectedStaged = resolve(stagedDir, `${index}-${pluginId}`);
    if (!pluginIds.includes(pluginId)
      || !allowedOriginals.get(pluginId)?.has(originalPath)
      || stagedPath !== expectedStaged
      || dirname(stagedPath) !== stagedDir
      || originals.has(originalPath)
      || staged.has(stagedPath)
      || originals.has(stagedPath)
      || staged.has(originalPath)) {
      throw new Error("Unsafe or ambiguous removal transaction mapping");
    }
    originals.add(originalPath);
    staged.add(stagedPath);
    return { pluginId, originalPath, stagedPath };
  });
  return {
    schemaVersion: 1,
    transactionId: expectedTransactionId,
    kind: value.kind,
    phase: value.phase,
    pluginIds,
    registryBefore: before.map(cloneEntry),
    registryAfter: after.map(cloneEntry),
    mappings,
  };
}

async function persistJournal(paths: PluginPaths, journal: RemovalTransactionJournal): Promise<void> {
  await assertOwnedTransactionDirectory(paths, journal.transactionId);
  const checked = assertJournal(paths, journal, journal.transactionId);
  writeUtf8FileAtomicSync(journalPath(paths, checked.transactionId), `${JSON.stringify(checked, null, 2)}\n`, 0o600);
  await assertOwnedTransactionDirectory(paths, journal.transactionId);
}

export async function readRemovalTransactionJournal(
  paths: PluginPaths,
  transactionId: string,
): Promise<RemovalTransactionJournal> {
  if (!UUID_RE.test(transactionId) || basename(transactionDir(paths, transactionId)) !== transactionId) {
    throw new Error("Invalid removal transaction id");
  }
  await assertOwnedTransactionDirectory(paths, transactionId);
  const path = journalPath(paths, transactionId);
  const noFollow = process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const linked = await lstat(path);
    if (!opened.isFile() || opened.size > MAX_JOURNAL_BYTES
      || !linked.isFile() || linked.isSymbolicLink()
      || linked.dev !== opened.dev || linked.ino !== opened.ino) {
      throw new Error("Invalid removal transaction journal size or ownership");
    }
    const raw = await handle.readFile({ encoding: "utf-8" });
    const afterRead = await handle.stat();
    if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino
      || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs
      || Buffer.byteLength(raw, "utf-8") !== opened.size) {
      throw new Error("Removal transaction journal changed while reading");
    }
    await assertOwnedTransactionDirectory(paths, transactionId);
    return assertJournal(paths, JSON.parse(raw) as unknown, transactionId);
  } finally {
    await handle.close();
  }
}

export async function createRemovalTransaction(
  paths: PluginPaths,
  input: {
    kind: RemovalTransactionKind;
    pluginIds: string[];
    registryBefore: PluginRegistryEntry[];
    registryAfter: PluginRegistryEntry[];
    originals: Array<{ pluginId: string; path: string }>;
  },
): Promise<RemovalTransactionJournal> {
  const transactionId = randomUUID();
  const txDir = transactionDir(paths, transactionId);
  await createOwnedTransactionDirectory(paths, transactionId);
  await assertOwnedTransactionDirectory(paths, transactionId);
  const journal: RemovalTransactionJournal = {
    schemaVersion: 1,
    transactionId,
    kind: input.kind,
    phase: "staging",
    pluginIds: [...input.pluginIds],
    registryBefore: input.registryBefore.map(cloneEntry),
    registryAfter: input.registryAfter.map(cloneEntry),
    mappings: input.originals.map((item, index) => ({
      pluginId: item.pluginId,
      originalPath: resolve(item.path),
      stagedPath: resolve(txDir, "staged", `${index}-${item.pluginId}`),
    })),
  };
  await persistJournal(paths, journal);
  return journal;
}

export async function stageRemovalTransaction(paths: PluginPaths, journal: RemovalTransactionJournal): Promise<void> {
  await assertOwnedTransactionDirectory(paths, journal.transactionId);
  for (const mapping of journal.mappings) {
    if (!existsSync(mapping.originalPath)) continue;
    await assertOwnedTransactionDirectory(paths, journal.transactionId);
    await retryOnTransientFsLock(() => rename(mapping.originalPath, mapping.stagedPath));
  }
}

export async function markRemovalTransactionRegistryCommitted(
  paths: PluginPaths,
  journal: RemovalTransactionJournal,
): Promise<void> {
  journal.phase = "registry-committed";
  await persistJournal(paths, journal);
}

async function removeTransactionStaged(paths: PluginPaths, journal: RemovalTransactionJournal): Promise<void> {
  await assertOwnedTransactionDirectory(paths, journal.transactionId);
  for (const mapping of journal.mappings) {
    await assertOwnedTransactionDirectory(paths, journal.transactionId);
    await retryOnTransientFsLock(() => rm(mapping.stagedPath, { recursive: true, force: true }));
  }
  await rm(transactionDir(paths, journal.transactionId), { recursive: true, force: true });
}

async function restoreTransactionStaged(
  paths: PluginPaths,
  journal: RemovalTransactionJournal,
  options: ReconcileOptions = {},
): Promise<void> {
  await assertOwnedTransactionDirectory(paths, journal.transactionId);
  for (const mapping of [...journal.mappings].reverse()) {
    const originalExists = existsSync(mapping.originalPath);
    const stagedExists = existsSync(mapping.stagedPath);
    if (originalExists && !stagedExists) continue;
    if (originalExists === stagedExists) throw new Error(`Ambiguous removal transaction path state: ${mapping.pluginId}`);
    await assertOwnedTransactionDirectory(paths, journal.transactionId);
    await retryOnTransientFsLock(
      () => (options.renamePath ?? rename)(mapping.stagedPath, mapping.originalPath),
      options.retry,
    );
  }
  await rm(transactionDir(paths, journal.transactionId), { recursive: true, force: true });
}

function registryProjection(registry: PluginRegistryEntry[], pluginIds: string[]): PluginRegistryEntry[] {
  const ids = new Set(pluginIds);
  return registry.filter((entry) => ids.has(entry.id)).map(cloneEntry)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizedProjection(entries: PluginRegistryEntry[]): string {
  return canonicalJSON(entries.map(cloneEntry).sort((a, b) => a.id.localeCompare(b.id)));
}

export async function reconcileRemovalTransaction(
  paths: PluginPaths,
  transactionId: string,
  options: ReconcileOptions = {},
): Promise<"restored" | "cleaned" | "unresolved"> {
  const journal = await readRemovalTransactionJournal(paths, transactionId);
  const registry = await readPluginRegistry(paths.registryPath);
  const current = normalizedProjection(registryProjection(registry.plugins, journal.pluginIds));
  if (current === normalizedProjection(journal.registryAfter)) {
    await removeTransactionStaged(paths, journal);
    return "cleaned";
  }
  if (current === normalizedProjection(journal.registryBefore)) {
    await restoreTransactionStaged(paths, journal, options);
    return "restored";
  }
  return "unresolved";
}

export async function reconcileRemovalTransactions(paths: PluginPaths, options: ReconcileOptions = {}): Promise<{
  restored: string[];
  cleaned: string[];
  unresolved: RemovalTransactionFailure[];
}> {
  const result: RemovalTransactionReconciliationResult = { restored: [], cleaned: [], unresolved: [] };
  let ids: string[];
  try {
    await assertOwnedTransactionRoot(paths);
    ids = await readdir(transactionRoot(paths));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    result.unresolved.push({ transactionId: "<removal-root>", reason: errorReason(error) });
    return result;
  }
  for (const id of ids) {
    try {
      const outcome = await reconcileRemovalTransaction(paths, id, options);
      if (outcome === "unresolved") {
        result.unresolved.push({
          transactionId: id,
          reason: "registry projection matches neither recorded state",
        });
      } else {
        result[outcome].push(id);
      }
    } catch (error) {
      result.unresolved.push({ transactionId: id, reason: errorReason(error) });
    }
  }
  return result;
}

export async function abortRemovalTransaction(paths: PluginPaths, journal: RemovalTransactionJournal): Promise<void> {
  await restoreTransactionStaged(paths, journal);
}

export async function finishRemovalTransaction(paths: PluginPaths, journal: RemovalTransactionJournal): Promise<void> {
  await removeTransactionStaged(paths, journal);
}
