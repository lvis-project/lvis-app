



import { resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import { JsonlRecordFile } from "../../audit/jsonl-reader.js";
import { createLogger } from "../../lib/logger.js";
import type { RiskVerdict } from "./risk-classifier.js";
import type { PermissionEvaluationContext } from "../evaluation-context.js";
import type { ToolCategory, ToolSource } from "../../tools/types.js";
import { lvisHome } from "../../shared/lvis-home.js";
import type { DeferredGrantScope } from "../../shared/permission-review-status.js";

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

export interface DeferredEntry {
  id: string;
  ts: string;
  /**
   * The conversation whose turn produced the entry. A deferred approval is a
   * question put to the user, and a window now holds several conversations side
   * by side, so it can only be asked in the tile that raised it. Absent when the
   * invocation belonged to no conversation (local API, plugin panel); those
   * entries are never asked and the queue dialog stays their only surface.
   */
  sessionId?: string;
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
  private readonly file: JsonlRecordFile<DeferredEntry>;
  private readonly onPendingChange?: (summary: { pending: number }) => void;
  private readonly onEntryPending?: (entry: DeferredEntry) => void;
  private entries: DeferredEntry[] | null = null;

  constructor(
    filePath?: string,
    onPendingChange?: (summary: { pending: number }) => void,
    /**
     * Fired once per newly appended entry, carrying the entry itself. The
     * count-only `onPendingChange` above drives a badge; this one drives the
     * ask, which needs the tool, the verdict, and the session to put the
     * question in front of the right conversation.
     */
    onEntryPending?: (entry: DeferredEntry) => void,
  ) {
    this.file = new JsonlRecordFile<DeferredEntry>(filePath ?? defaultPath(), {
      accept: (parsed): parsed is DeferredEntry => {
        const entry = parsed as Partial<DeferredEntry> | null;
        return Boolean(entry && entry.id && entry.toolName && entry.status);
      },
      onMalformedLine: (line) => log.warn(`skipping malformed deferred-queue line: ${line.trim().slice(0, 80)}`),
      onReadFailure: (err) => log.warn(`failed to read deferred-queue: %s`, (err as Error).message),
    });
    this.onPendingChange = onPendingChange;
    this.onEntryPending = onEntryPending;
  }

  private ensureLoaded(): void {
    if (this.entries !== null) return;
    this.entries = this.file.loadSync();
  }

  /**
   * Append a new pending entry. Returns the assigned id so callers
   * can correlate with audit log records.
   */
  async append(params: {
    /** Conversation that raised this; omitted when there is none. */
    sessionId?: string;
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
    await this.file.append(entry);
    this.emitPendingChange();
    try {
      this.onEntryPending?.(entry);
    } catch (err) {
      log.warn(`failed to announce pending deferred entry: %s`, (err as Error).message);
    }
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
    await this.file.rewrite(this.entries!);
    this.emitPendingChange();
    return next;
  }

  /** Test helper. */
  resetForTests(): void {
    this.entries = null;
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
