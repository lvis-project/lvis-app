import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";

export interface PluginGenerationHealthFault {
  pluginId: string;
  generationId: string;
  phase:
    | "runtime-post-publish"
    | "loopback-post-publish"
    | "mcp-publication"
    | "mcp-predecessor-retirement";
  recordedAt: string;
  errorName: string;
  errorCode: string | null;
  message: "internal post-commit fault";
}

interface HealthJournalFile {
  version: 1;
  faults: PluginGenerationHealthFault[];
}

/** Durable visibility for internal faults discovered after pointer commit. */
export class PluginGenerationHealthJournal {
  private readonly records = new Map<string, PluginGenerationHealthFault>();

  constructor(private readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as HealthJournalFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.faults)) {
        throw new Error("unsupported plugin generation health journal");
      }
      for (const fault of parsed.faults) {
        if (!fault?.pluginId || !/^[a-f0-9]{64}$/.test(fault.generationId)) {
          throw new Error("invalid plugin generation health journal record");
        }
        this.records.set(this.key(fault.pluginId, fault.generationId, fault.phase), Object.freeze({ ...fault }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): readonly PluginGenerationHealthFault[] {
    return Object.freeze([...this.records.values()].map((record) => Object.freeze({ ...record })));
  }

  record(
    pluginId: string,
    generationId: string,
    phase: PluginGenerationHealthFault["phase"],
    error: unknown,
  ): void {
    const fault: PluginGenerationHealthFault = {
      pluginId,
      generationId,
      phase,
      recordedAt: new Date().toISOString(),
      ...opaqueHealthError(error),
    };
    this.records.set(this.key(pluginId, generationId, phase), Object.freeze(fault));
    this.persist();
  }

  clearGeneration(pluginId: string, generationId: string): void {
    let changed = false;
    for (const [key, record] of this.records) {
      if (record.pluginId === pluginId && record.generationId === generationId) {
        this.records.delete(key);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private key(pluginId: string, generationId: string, phase: string): string {
    return `${pluginId}\0${generationId}\0${phase}`;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body: HealthJournalFile = { version: 1, faults: [...this.records.values()] };
    writeUtf8FileAtomicSync(this.path, `${JSON.stringify(body, null, 2)}\n`, 0o600);
  }
}

/**
 * Post-commit failures can originate in provider/MCP code and may carry URLs,
 * headers, response bodies, or credentials in their message.  The durable
 * journal is diagnostic metadata, not a raw exception sink: phase and a stable
 * name/code are sufficient to route remediation without persisting secrets.
 */
export function opaqueHealthError(error: unknown): Pick<
  PluginGenerationHealthFault,
  "errorName" | "errorCode" | "message"
> {
  const candidate = error as { name?: unknown; code?: unknown } | null;
  const rawName = candidate && typeof candidate.name === "string" ? candidate.name : "UnknownError";
  const rawCode = candidate && typeof candidate.code === "string" ? candidate.code : null;
  return {
    errorName: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName) ? rawName : "UnknownError",
    errorCode: rawCode && /^[A-Z0-9_-]{1,64}$/.test(rawCode) ? rawCode : null,
    message: "internal post-commit fault",
  };
}

export function pluginGenerationHealthJournalPath(cacheRoot: string): string {
  return resolve(cacheRoot, "plugin-generation-health.json");
}
