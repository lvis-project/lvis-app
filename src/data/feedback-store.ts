/**
 * Feedback Store — D6 thumbs-up/down message feedback persistence.
 *
 * Stores user feedback separately from the audit log to keep PII/free-text
 * out of security-audit infrastructure (GDPR §17 / privacy hardening).
 * Persists to ~/.lvis/feedback.jsonl with 90-day retention.
 *
 * Schema mirrors StarredStore pattern (src/data/starred-store.ts).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface FeedbackEntry {
  /** uuid */
  id: string;
  sessionId: string;
  messageIndex: number;
  rating: "up" | "down";
  /** Optional free-text reason — stored here only, never in audit log */
  reason?: string;
  /** ISO timestamp */
  timestamp: string;
}

export interface FeedbackStoreOptions {
  /** Override file path for tests */
  filePath?: string;
  /** Retention in days. Default: 90 */
  retentionDays?: number;
}

export class FeedbackStore {
  private readonly filePath: string;
  private readonly retentionDays: number;

  constructor(options?: FeedbackStoreOptions) {
    this.filePath = resolve(options?.filePath ?? join(homedir(), ".lvis", "feedback.jsonl"));
    this.retentionDays = options?.retentionDays ?? 90;
  }

  /** Append a feedback entry to the JSONL file. */
  add(entry: Omit<FeedbackEntry, "id" | "timestamp"> & { id?: string; timestamp?: string }): FeedbackEntry {
    const record: FeedbackEntry = {
      id: entry.id ?? crypto.randomUUID(),
      sessionId: entry.sessionId,
      messageIndex: entry.messageIndex,
      rating: entry.rating,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      timestamp: entry.timestamp ?? new Date().toISOString(),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf-8");
    return record;
  }

  /** Read all entries, optionally filtered by sessionId. */
  list(sessionId?: string): FeedbackEntry[] {
    if (!existsSync(this.filePath)) return [];
    const lines = readFileSync(this.filePath, "utf-8").trim().split("\n").filter(Boolean);
    const entries: FeedbackEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as FeedbackEntry;
        if (!sessionId || e.sessionId === sessionId) entries.push(e);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }

  /**
   * Prune entries older than retentionDays. Rewrites the file in-place.
   * Call periodically (e.g. on app boot) — non-fatal if it fails.
   */
  prune(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const cutoff = Date.now() - this.retentionDays * 86_400_000;
      const kept = this.list().filter((e) => new Date(e.timestamp).getTime() >= cutoff);
      writeFileSync(this.filePath, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), "utf-8");
    } catch {
      // Non-fatal
    }
  }
}
