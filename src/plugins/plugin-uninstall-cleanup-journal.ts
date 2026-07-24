import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";

export interface PluginUninstallCleanupRecord {
  pluginId: string;
  installPluginId: string;
  secretKeys: readonly string[];
  authPartitions: readonly string[];
  cleanupCache: boolean;
  registryRemovalCommitted: boolean;
  runtimeRetirementComplete: boolean;
  recordedAt: string;
  attempts: number;
  completedPhases: readonly PluginUninstallCleanupPhase[];
  completedAuthPartitions: readonly string[];
}

export type PluginUninstallCleanupPhase =
  | "config"
  | "secrets"
  | "auth-tracker"
  | "cache";

interface JournalFile {
  version: 3;
  cleanups: PluginUninstallCleanupRecord[];
}

interface LegacyJournalFileV2 {
  version: 2;
  cleanups: Array<Omit<PluginUninstallCleanupRecord, "runtimeRetirementComplete">>;
}

interface LegacyJournalFileV1 {
  version: 1;
  cleanups: Array<
    Omit<
      PluginUninstallCleanupRecord,
      "registryRemovalCommitted" | "runtimeRetirementComplete"
    >
  >;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const CLEANUP_PHASES = new Set<PluginUninstallCleanupPhase>([
  "config",
  "secrets",
  "auth-tracker",
  "cache",
]);
const MAX_RECORDS = 1_000;
const MAX_VALUES_PER_RECORD = 1_000;

function isCleanupPhaseArray(
  value: unknown,
): value is PluginUninstallCleanupPhase[] {
  return isStringArray(value)
    && value.every((phase) =>
      CLEANUP_PHASES.has(phase as PluginUninstallCleanupPhase));
}

function isOwnedAuthPartition(pluginId: string, partition: string): boolean {
  const base = `persist:plugin-auth:${encodeURIComponent(pluginId)}`;
  return partition === base || partition.startsWith(`${base}:`);
}

function freezeRecord(
  record: PluginUninstallCleanupRecord,
): PluginUninstallCleanupRecord {
  return Object.freeze({
    ...record,
    secretKeys: Object.freeze([...record.secretKeys]),
    authPartitions: Object.freeze([...record.authPartitions]),
    completedPhases: Object.freeze([...record.completedPhases]),
    completedAuthPartitions: Object.freeze([
      ...record.completedAuthPartitions,
    ]),
  });
}

/**
 * Durable ownership record for Host state that must outlive registry removal.
 *
 * The record is written before the marketplace commit. Cleanup phases are
 * idempotent and checkpointed individually, so a crash or partial OS failure
 * can resume without needing the removed plugin manifest or runtime identity.
 */
export class PluginUninstallCleanupJournal {
  private readonly records = new Map<string, PluginUninstallCleanupRecord>();

  constructor(private readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as
        | JournalFile
        | LegacyJournalFileV2
        | LegacyJournalFileV1;
      if (
        (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3)
        || !Array.isArray(parsed.cleanups)
      ) {
        throw new Error("unsupported plugin uninstall cleanup journal");
      }
      if (parsed.cleanups.length > MAX_RECORDS) {
        throw new Error("plugin uninstall cleanup journal is too large");
      }
      for (const persistedRecord of parsed.cleanups) {
        // Older journal versions predate explicit registry and runtime
        // retirement checkpoints. Recovery must prove those states again.
        const record = {
          ...persistedRecord,
          registryRemovalCommitted:
            parsed.version >= 2
              && "registryRemovalCommitted" in persistedRecord
              ? persistedRecord.registryRemovalCommitted
              : false,
          runtimeRetirementComplete:
            parsed.version === 3
              && "runtimeRetirementComplete" in persistedRecord
              ? persistedRecord.runtimeRetirementComplete
              : false,
        };
        if (
          !record
          || typeof record.pluginId !== "string"
          || record.pluginId.length === 0
          || typeof record.installPluginId !== "string"
          || record.installPluginId.length === 0
          || !isStringArray(record.secretKeys)
          || !isStringArray(record.authPartitions)
          || record.secretKeys.length > MAX_VALUES_PER_RECORD
          || record.authPartitions.length > MAX_VALUES_PER_RECORD
          || record.authPartitions.some(
            (partition) => !isOwnedAuthPartition(record.pluginId, partition),
          )
          || typeof record.cleanupCache !== "boolean"
          || typeof record.registryRemovalCommitted !== "boolean"
          || typeof record.runtimeRetirementComplete !== "boolean"
          || typeof record.recordedAt !== "string"
          || !Number.isSafeInteger(record.attempts)
          || record.attempts < 0
          || !isCleanupPhaseArray(record.completedPhases)
          || !isStringArray(record.completedAuthPartitions)
          || record.completedAuthPartitions.length > MAX_VALUES_PER_RECORD
          || record.completedAuthPartitions.some(
            (partition) => !record.authPartitions.includes(partition),
          )
        ) {
          throw new Error("invalid plugin uninstall cleanup journal record");
        }
        if (this.records.has(record.pluginId)) {
          throw new Error("duplicate plugin uninstall cleanup journal record");
        }
        this.records.set(record.pluginId, freezeRecord(record));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): readonly PluginUninstallCleanupRecord[] {
    return Object.freeze([...this.records.values()].map(freezeRecord));
  }

  find(pluginId: string): PluginUninstallCleanupRecord | undefined {
    const direct = this.records.get(pluginId);
    const record = direct
      ?? [...this.records.values()].find(
        (candidate) => candidate.installPluginId === pluginId,
      );
    return record ? freezeRecord(record) : undefined;
  }

  prepare(input: {
    pluginId: string;
    installPluginId: string;
    secretKeys: readonly string[];
    authPartitions: readonly string[];
    cleanupCache: boolean;
  }): PluginUninstallCleanupRecord {
    if (this.records.has(input.pluginId)) {
      throw new Error(
        `plugin uninstall cleanup is already pending: ${input.pluginId}`,
      );
    }
    if (
      input.secretKeys.length > MAX_VALUES_PER_RECORD
      || input.authPartitions.length > MAX_VALUES_PER_RECORD
      || input.authPartitions.some(
        (partition) => !isOwnedAuthPartition(input.pluginId, partition),
      )
    ) {
      throw new Error(
        `invalid plugin uninstall cleanup plan: ${input.pluginId}`,
      );
    }
    const record = freezeRecord({
      ...input,
      secretKeys: [...new Set(input.secretKeys)],
      authPartitions: [...new Set(input.authPartitions)],
      registryRemovalCommitted: false,
      runtimeRetirementComplete: false,
      recordedAt: new Date().toISOString(),
      attempts: 0,
      completedPhases: [],
      completedAuthPartitions: [],
    });
    this.replaceRecord(record);
    return freezeRecord(record);
  }

  beginAttempt(pluginId: string): PluginUninstallCleanupRecord {
    const previous = this.require(pluginId);
    const next = freezeRecord({
      ...previous,
      attempts: previous.attempts + 1,
    });
    this.replaceRecord(next);
    return freezeRecord(next);
  }

  markRegistryRemovalCommitted(
    pluginId: string,
    options: { cleanupCache?: boolean } = {},
  ): PluginUninstallCleanupRecord {
    const previous = this.require(pluginId);
    const cleanupCache = previous.cleanupCache || options.cleanupCache === true;
    if (
      previous.registryRemovalCommitted
      && cleanupCache === previous.cleanupCache
    ) {
      return freezeRecord(previous);
    }
    const next = freezeRecord({
      ...previous,
      cleanupCache,
      registryRemovalCommitted: true,
    });
    this.replaceRecord(next);
    return freezeRecord(next);
  }

  markRuntimeRetirementComplete(
    pluginId: string,
  ): PluginUninstallCleanupRecord {
    const previous = this.require(pluginId);
    if (previous.runtimeRetirementComplete) return freezeRecord(previous);
    const next = freezeRecord({
      ...previous,
      runtimeRetirementComplete: true,
    });
    this.replaceRecord(next);
    return freezeRecord(next);
  }

  mergeAuthPartitions(
    pluginId: string,
    partitions: readonly string[],
  ): PluginUninstallCleanupRecord {
    const previous = this.require(pluginId);
    const merged = [...new Set([...previous.authPartitions, ...partitions])];
    if (
      merged.length > MAX_VALUES_PER_RECORD
      || merged.some((partition) => !isOwnedAuthPartition(pluginId, partition))
    ) {
      throw new Error(`invalid plugin uninstall auth partition plan: ${pluginId}`);
    }
    if (merged.length === previous.authPartitions.length) {
      return freezeRecord(previous);
    }
    const next = freezeRecord({
      ...previous,
      authPartitions: merged,
      completedPhases: previous.completedPhases.filter(
        (phase) => phase !== "auth-tracker",
      ),
    });
    this.replaceRecord(next);
    return freezeRecord(next);
  }

  completePhase(
    pluginId: string,
    phase: PluginUninstallCleanupPhase,
  ): void {
    const previous = this.require(pluginId);
    if (previous.completedPhases.includes(phase)) return;
    const next = freezeRecord({
      ...previous,
      completedPhases: [...previous.completedPhases, phase],
    });
    this.replaceRecord(next);
  }

  completeAuthPartition(pluginId: string, partition: string): void {
    const previous = this.require(pluginId);
    if (!previous.authPartitions.includes(partition)) {
      throw new Error(
        `auth partition is not owned by uninstall cleanup: ${pluginId}`,
      );
    }
    if (previous.completedAuthPartitions.includes(partition)) return;
    this.replaceRecord(freezeRecord({
      ...previous,
      completedAuthPartitions: [
        ...previous.completedAuthPartitions,
        partition,
      ],
    }));
  }

  cancel(pluginId: string): void {
    this.complete(pluginId);
  }

  complete(pluginId: string): void {
    if (!this.records.has(pluginId)) return;
    const next = new Map(this.records);
    next.delete(pluginId);
    this.persist(next);
    this.records.delete(pluginId);
  }

  private require(pluginId: string): PluginUninstallCleanupRecord {
    const record = this.records.get(pluginId);
    if (!record) {
      throw new Error(`plugin uninstall cleanup is not journaled: ${pluginId}`);
    }
    return record;
  }

  private replaceRecord(record: PluginUninstallCleanupRecord): void {
    const next = new Map(this.records);
    next.set(record.pluginId, record);
    this.persist(next);
    this.records.set(record.pluginId, record);
  }

  private persist(
    records: ReadonlyMap<string, PluginUninstallCleanupRecord>,
  ): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body: JournalFile = {
      version: 3,
      cleanups: [...records.values()],
    };
    writeUtf8FileAtomicSync(
      this.path,
      `${JSON.stringify(body, null, 2)}\n`,
      0o600,
    );
  }
}

export function pluginUninstallCleanupJournalPath(cacheRoot: string): string {
  return resolve(cacheRoot, "plugin-uninstall-cleanup.json");
}
