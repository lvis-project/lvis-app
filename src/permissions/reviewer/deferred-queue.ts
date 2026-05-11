/**
 * Layer 5 reviewer queue for MED/HIGH headless verdicts.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 5.
 *
 * When the reviewer agent returns a MEDIUM/HIGH verdict in headless mode, the
 * action is appended to the deferred queue rather than executed. On
 * pending-count changes the host emits
 * `lvis:permissions:deferred-pending` with a queue summary; the renderer
 * lets the user open a DeferredQueuePanel with "허용" / "거부" buttons. Each
 * click resolves the entry and writes an audit record.
 *
 * Storage: ~/.lvis/permissions/deferred-queue.jsonl (per-feature
 * namespace; Layer 0 sensitive — no plugin can read or write it
 * directly).
 *
 * Append-on-classification, drain-on-foreground. Resolved entries
 * remain in the file as historical record (status: "approved" |
 * "rejected") so the audit chain is preserved even after queue drain.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "../../lib/with-file-lock.js";
import { createLogger } from "../../lib/logger.js";
import type { RiskVerdict } from "./risk-classifier.js";
import type { ToolCategory, ToolSource } from "../../tools/types.js";

const log = createLogger("deferred-queue");

export type DeferredEntryStatus = "pending" | "approved" | "rejected";

export interface DeferredEntry {
  id: string;
  ts: string;
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  /** DLP-redacted finalInput summary (NOT the raw input). */
  inputSummary: string;
  verdict: RiskVerdict;
  status: DeferredEntryStatus;
  /** When status !== "pending", the resolution decision timestamp. */
  resolvedAt?: string;
  /** Free-form reason from the user (e.g. "approved after review"). */
  resolutionReason?: string;
}

function defaultPath(): string {
  return pathResolve(homedir(), ".lvis", "permissions", "deferred-queue.jsonl");
}

export class DeferredQueue {
  private readonly filePath: string;
  private readonly onPendingChange?: (summary: { pending: number }) => void;
  private entries: DeferredEntry[] | null = null;

  constructor(
    filePath?: string,
    onPendingChange?: (summary: { pending: number }) => void,
  ) {
    this.filePath = filePath ?? defaultPath();
    this.onPendingChange = onPendingChange;
  }

  private ensureLoaded(): void {
    if (this.entries !== null) return;
    if (!existsSync(this.filePath)) {
      this.entries = [];
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const out: DeferredEntry[] = [];
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const parsed = JSON.parse(t) as DeferredEntry;
          if (parsed.id && parsed.toolName && parsed.status) out.push(parsed);
        } catch {
          log.warn(`skipping malformed deferred-queue line: ${t.slice(0, 80)}`);
        }
      }
      this.entries = out;
    } catch (err) {
      log.warn(`failed to read deferred-queue: %s`, (err as Error).message);
      this.entries = [];
    }
  }

  /**
   * Append a new pending entry. Returns the assigned id so callers
   * can correlate with audit log records.
   */
  async append(params: {
    toolName: string;
    source: ToolSource;
    category: ToolCategory;
    inputSummary: string;
    verdict: RiskVerdict;
  }): Promise<string> {
    this.ensureLoaded();
    const id = randomUUID();
    const entry: DeferredEntry = {
      id,
      ts: new Date().toISOString(),
      ...params,
      status: "pending",
    };
    this.entries!.push(entry);
    await this.appendLine(entry);
    this.emitPendingChange();
    return id;
  }

  /**
   * List pending entries (for IPC `lvis:permissions:deferred-pending`).
   * Resolved entries remain in the file but are NOT returned here.
   */
  listPending(): DeferredEntry[] {
    this.ensureLoaded();
    return this.entries!.filter((e) => e.status === "pending");
  }

  /** Total queue size (including resolved). For diagnostics. */
  size(): number {
    this.ensureLoaded();
    return this.entries!.length;
  }

  /** Return a queue entry by id without mutating it. */
  get(id: string): DeferredEntry | null {
    this.ensureLoaded();
    return this.entries!.find((entry) => entry.id === id) ?? null;
  }

  /**
   * Resolve a pending entry. Rewrites the file to persist the new
   * status. Returns the resolved entry for caller's audit-write step.
   */
  async resolve(
    id: string,
    decision: "approved" | "rejected",
    reason?: string,
  ): Promise<DeferredEntry | null> {
    this.ensureLoaded();
    const idx = this.entries!.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const entry = this.entries![idx];
    if (entry.status !== "pending") {
      // Already resolved — idempotent return.
      return entry;
    }
    const next: DeferredEntry = {
      ...entry,
      status: decision,
      resolvedAt: new Date().toISOString(),
      resolutionReason: reason,
    };
    this.entries![idx] = next;
    await this.rewriteFromMemory();
    this.emitPendingChange();
    return next;
  }

  /** Test helper. */
  resetForTests(): void {
    this.entries = null;
  }

  private async appendLine(entry: DeferredEntry): Promise<void> {
    await withFileLock(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const line = JSON.stringify(entry) + "\n";
      // O(1) append — previous implementation read+rewrote the entire
      // file (O(n) per append). The full-rewrite path remains in
      // rewriteFromMemory() for resolve operations that mutate
      // existing entries.
      appendFileSync(this.filePath, line, { encoding: "utf-8", mode: 0o600 });
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // Non-fatal — chmod failure must not block queue writes.
      }
    });
  }

  private async rewriteFromMemory(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const body =
        this.entries!.map((e) => JSON.stringify(e)).join("\n") +
        (this.entries!.length > 0 ? "\n" : "");
      writeFileSync(this.filePath, body, { encoding: "utf-8", mode: 0o600 });
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // Non-fatal — chmod failure must not block queue writes.
      }
    });
  }

  private emitPendingChange(): void {
    if (!this.onPendingChange) return;
    try {
      this.onPendingChange({ pending: this.listPending().length });
    } catch (err) {
      log.warn(`failed to emit deferred-queue pending summary: %s`, (err as Error).message);
    }
  }
}
