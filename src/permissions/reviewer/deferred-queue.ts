



import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "../../lib/with-file-lock.js";
import { createLogger } from "../../lib/logger.js";
import type { RiskVerdict } from "./risk-classifier.js";
import type { PermissionEvaluationContext } from "../evaluation-context.js";
import type { ToolCategory, ToolSource } from "../../tools/types.js";
import { lvisHome } from "../../shared/lvis-home.js";

const log = createLogger("deferred-queue");

export type DeferredEntryStatus = "pending" | "approved" | "rejected";

/**
 * What resolving an entry with `"approved"` will actually GRANT.
 *
 * A deferred entry is raised on the headless path: the tool call has already
 * returned an error, its `tool_use_id` is consumed, and the turn has moved on
 * (the queue is a JSONL file that outlives the process). So approving one can
 * never re-drive the original call — there is no live turn to attach a result
 * to, and re-executing a write/shell tool outside its conversation would run a
 * side effect nobody is waiting for and nobody can abort.
 *
 * What approval CAN honestly mean is forward-looking: register the grant so the
 * next equivalent call succeeds without asking. That is only reconstructable
 * when the producer recorded a concrete target:
 *
 *   • `"directory"` — the out-of-allowed-dir lane. `path` is host-derived from
 *     `pickClosestParent`, never user-typed, so a confirmation line can name a
 *     concrete directory the host itself resolved.
 *   • absent — nothing reconstructable. The strict-mode reviewer lane defers on
 *     an exact (tool, args, source) tuple, and only a DLP-redacted
 *     `inputSummary` survives, so no grant can be rebuilt from the entry. The
 *     resolve path REFUSES `"approved"` for these rather than record an
 *     approval that grants nothing.
 */
export type DeferredGrant = { kind: "directory"; path: string };

/**
 * Grant breadth available when resolving a deferred entry.
 *
 * Deliberately NOT the foreground card's three-way choice: `allow-once` has no
 * meaning here. "Once" scopes a grant to the call being decided, and that call
 * is already over — a post-hoc "once" would grant nothing and expire against
 * nothing. The honest breadths are the two that outlive the dead call, and
 * `"session"` is the narrower of them, so it is the default and the fallback
 * for any ambiguous request.
 */
export type DeferredGrantScope = "session" | "always";

/** Narrowest breadth a deferred approval can carry. */
export const NARROWEST_DEFERRED_SCOPE: DeferredGrantScope = "session";

export interface DeferredEntry {
  id: string;
  ts: string;
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  /** DLP-redacted finalInput summary (NOT the raw input). */
  inputSummary: string;
  /** Captured policy/sandbox context for user review. */
  evaluationContext?: PermissionEvaluationContext;
  verdict: RiskVerdict;
  /**
   * What an `"approved"` resolution grants. Absent ⇒ nothing is
   * reconstructable and `"approved"` is refused — see {@link DeferredGrant}.
   */
  grant?: DeferredGrant;
  status: DeferredEntryStatus;
  /** When status !== "pending", the resolution decision timestamp. */
  resolvedAt?: string;
  /** Grant breadth applied at resolution time, for entries that had a grant. */
  resolvedScope?: DeferredGrantScope;
  /** Free-form reason from the user (e.g. "approved after review"). */
  resolutionReason?: string;
}

function defaultPath(): string {
  return pathResolve(lvisHome(), "permissions", "deferred-queue.jsonl");
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
    evaluationContext?: PermissionEvaluationContext;
    verdict: RiskVerdict;
    /**
     * Omit when the lane cannot reconstruct a grant. Omitting is not a
     * formality — it makes `"approved"` unavailable for the entry.
     */
    grant?: DeferredGrant;
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
    scope?: DeferredGrantScope,
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
      ...(decision === "approved" && scope ? { resolvedScope: scope } : {}),
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
