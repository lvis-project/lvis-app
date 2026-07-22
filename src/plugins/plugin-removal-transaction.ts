import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
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

interface ReconcileOptions {
  renamePath?: typeof rename;
  retry?: Parameters<typeof retryOnTransientFsLock>[1];
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

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe removal transaction ${label}`);
  }
}

async function assertOwnedTransactionDirectory(paths: PluginPaths, transactionId: string): Promise<void> {
  const root = transactionRoot(paths);
  const txDir = transactionDir(paths, transactionId);
  const stagedDir = resolve(txDir, "staged");
  await assertRealDirectory(root, "root");
  await assertRealDirectory(txDir, "directory");
  await assertRealDirectory(stagedDir, "staged directory");
  const realRoot = await realpath(root);
  const realTxDir = await realpath(txDir);
  const realStagedDir = await realpath(stagedDir);
  if (realTxDir !== resolve(realRoot, transactionId)
    || realStagedDir !== resolve(realTxDir, "staged")) {
    throw new Error("Unsafe removal transaction directory ownership");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Invalid ${label} keys`);
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

function persistJournal(paths: PluginPaths, journal: RemovalTransactionJournal): void {
  const checked = assertJournal(paths, journal, journal.transactionId);
  writeUtf8FileAtomicSync(journalPath(paths, checked.transactionId), `${JSON.stringify(checked, null, 2)}\n`, 0o600);
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
  const stat = await lstat(path);
  const realTxDir = await realpath(transactionDir(paths, transactionId));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES
    || await realpath(path) !== resolve(realTxDir, JOURNAL_FILE)) {
    throw new Error("Invalid removal transaction journal size or ownership");
  }
  return assertJournal(paths, JSON.parse(await readFile(path, "utf-8")) as unknown, transactionId);
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
  await mkdir(resolve(txDir, "staged"), { recursive: true, mode: 0o700 });
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
  persistJournal(paths, journal);
  return journal;
}

export async function stageRemovalTransaction(journal: RemovalTransactionJournal): Promise<void> {
  for (const mapping of journal.mappings) {
    if (!existsSync(mapping.originalPath)) continue;
    await retryOnTransientFsLock(() => rename(mapping.originalPath, mapping.stagedPath));
  }
}

export function markRemovalTransactionRegistryCommitted(paths: PluginPaths, journal: RemovalTransactionJournal): void {
  journal.phase = "registry-committed";
  persistJournal(paths, journal);
}

async function removeTransactionStaged(paths: PluginPaths, journal: RemovalTransactionJournal): Promise<void> {
  for (const mapping of journal.mappings) {
    await retryOnTransientFsLock(() => rm(mapping.stagedPath, { recursive: true, force: true }));
  }
  await rm(transactionDir(paths, journal.transactionId), { recursive: true, force: true });
}

async function restoreTransactionStaged(
  paths: PluginPaths,
  journal: RemovalTransactionJournal,
  options: ReconcileOptions = {},
): Promise<void> {
  for (const mapping of [...journal.mappings].reverse()) {
    const originalExists = existsSync(mapping.originalPath);
    const stagedExists = existsSync(mapping.stagedPath);
    if (originalExists && !stagedExists) continue;
    if (originalExists === stagedExists) throw new Error(`Ambiguous removal transaction path state: ${mapping.pluginId}`);
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

export async function reconcileRemovalTransactions(paths: PluginPaths): Promise<{
  restored: string[];
  cleaned: string[];
  unresolved: string[];
}> {
  const result = { restored: [] as string[], cleaned: [] as string[], unresolved: [] as string[] };
  let ids: string[];
  try {
    ids = await readdir(transactionRoot(paths));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const id of ids) {
    try {
      const outcome = await reconcileRemovalTransaction(paths, id);
      result[outcome].push(id);
    } catch {
      result.unresolved.push(id);
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
