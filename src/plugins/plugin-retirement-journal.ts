import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";

export interface PluginRetirementRecord {
  pluginId: string;
  generationId: string;
  recordedAt: string;
  attempts: number;
  lastError?: string;
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
        if (!record?.pluginId || !/^[a-f0-9]{64}$/.test(record.generationId)) {
          throw new Error("invalid plugin retirement journal record");
        }
        this.records.set(this.key(record.pluginId, record.generationId), Object.freeze({ ...record }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): readonly PluginRetirementRecord[] {
    return Object.freeze([...this.records.values()].map((record) => Object.freeze({ ...record })));
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
    };
    this.records.set(key, Object.freeze(next));
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
