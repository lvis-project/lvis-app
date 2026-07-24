import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";

export interface PluginRetirementRecord {
  pluginId: string;
  generationId: string;
  recordedAt: string;
  attempts: number;
  lastError?: string;
  completedPhases?: readonly string[];
}

interface JournalFile {
  version: 1;
  retirements: PluginRetirementRecord[];
}

export class PluginRetirementJournal {
  private readonly records = new Map<string, PluginRetirementRecord>();

  constructor(private readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as JournalFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.retirements)) {
        throw new Error("unsupported plugin retirement journal");
      }
      for (const record of parsed.retirements) {
        if (
          !record?.pluginId
          || !/^[a-f0-9]{64}$/.test(record.generationId)
          || (
            record.completedPhases !== undefined
            && (
              !Array.isArray(record.completedPhases)
              || record.completedPhases.some((phase) => typeof phase !== "string" || !phase)
            )
          )
        ) {
          throw new Error("invalid plugin retirement journal record");
        }
        this.records.set(this.key(record.pluginId, record.generationId), Object.freeze({
          ...record,
          ...(record.completedPhases
            ? { completedPhases: Object.freeze([...record.completedPhases]) }
            : {}),
        }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): readonly PluginRetirementRecord[] {
    return Object.freeze([...this.records.values()].map((record) => Object.freeze({
      ...record,
      ...(record.completedPhases
        ? { completedPhases: Object.freeze([...record.completedPhases]) }
        : {}),
    })));
  }

  record(pluginId: string, generationId: string, error?: unknown): void {
    const key = this.key(pluginId, generationId);
    const previous = this.records.get(key);
    const next: PluginRetirementRecord = {
      pluginId,
      generationId,
      recordedAt: previous?.recordedAt ?? new Date().toISOString(),
      attempts: (previous?.attempts ?? 0) + 1,
      ...(error !== undefined
        ? { lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }
        : previous?.lastError ? { lastError: previous.lastError } : {}),
      ...(previous?.completedPhases
        ? { completedPhases: Object.freeze([...previous.completedPhases]) }
        : {}),
    };
    this.records.set(key, Object.freeze(next));
    this.persist();
  }

  completePhase(pluginId: string, generationId: string, phase: string): void {
    const key = this.key(pluginId, generationId);
    const previous = this.records.get(key);
    if (!previous) {
      throw new Error(`plugin retirement is not journaled: ${pluginId}:${generationId}`);
    }
    const completedPhases = new Set(previous.completedPhases ?? []);
    if (completedPhases.has(phase)) return;
    completedPhases.add(phase);
    this.records.set(key, Object.freeze({
      ...previous,
      completedPhases: Object.freeze([...completedPhases]),
    }));
    this.persist();
  }

  complete(pluginId: string, generationId: string): void {
    if (!this.records.delete(this.key(pluginId, generationId))) return;
    this.persist();
  }

  private key(pluginId: string, generationId: string): string {
    return `${pluginId}\0${generationId}`;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body: JournalFile = { version: 1, retirements: [...this.records.values()] };
    writeUtf8FileAtomicSync(this.path, `${JSON.stringify(body, null, 2)}\n`, 0o600);
  }
}

export function pluginRetirementJournalPath(cacheRoot: string): string {
  return resolve(cacheRoot, "plugin-retirement-journal.json");
}
