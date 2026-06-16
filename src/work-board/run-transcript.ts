/**
 * Persistent per-item run transcript for the Work Board agentic engine.
 *
 * Before this, a plan→approve→execute run lived entirely in memory: only the
 * distilled `plan` / `output` text was persisted to `board.json`, and the
 * sub-agent conversations (plan-phase investigation, execute-phase turns) were
 * lost on run-end or app restart. That broke continuity — successive runs could
 * not build on prior work and an interrupted run vanished.
 *
 * Each run now streams its conversation to an append-only JSONL transcript at
 * `~/.lvis/work-board/sessions/<itemId>/<runId>.jsonl`. Re-running an item
 * starts a NEW `runId` file, so prior runs are preserved (never overwritten) —
 * `board.json`'s `runHistory[]` is the index of run ids. This mirrors the
 * routine-v2 session pattern (`~/.lvis/routine/sessions/<id>/<firedAt>.jsonl`).
 *
 * Append is read-modify-write (the storage seam exposes no native append, same
 * as activity-log.ts). Transcripts are bounded by the run's turn cap (plan ≤ 6,
 * execute ≤ 30), so the rewrite stays cheap.
 */
import type { WorkBoardStorage } from "./storage.js";
import type { RunTranscriptEvent } from "../shared/work-board-types.js";

export type { RunTranscriptEvent };

/** Narrow storage slice the transcript needs (append = read-modify-write). */
export type TranscriptStorage = Pick<WorkBoardStorage, "readText" | "write" | "exists" | "mkdir">;

/** Relative path (under the work-board namespace) of a run's transcript file. */
export function runTranscriptPath(itemId: number, runId: string): string {
  return `sessions/${itemId}/${runId}.jsonl`;
}

/**
 * Writer bound to one (itemId, runId). `append` is serialized by the caller
 * (the engine appends sequentially within a single run), so no lock is needed
 * beyond the read-modify-write being awaited before the next append.
 */
export interface RunTranscriptWriter {
  append(event: Omit<RunTranscriptEvent, "ts"> & { ts?: string }): Promise<void>;
}

/** Create an append-only transcript writer for one run. */
export function createRunTranscript(
  storage: TranscriptStorage,
  itemId: number,
  runId: string,
  now: () => number = Date.now,
): RunTranscriptWriter {
  const path = runTranscriptPath(itemId, runId);
  return {
    async append(event) {
      const full: RunTranscriptEvent = { ...event, ts: event.ts ?? new Date(now()).toISOString() };
      const line = JSON.stringify(full) + "\n";
      const prior = (await storage.exists(path)) ? await storage.readText(path) : "";
      await storage.write(path, prior + line);
    },
  };
}

/**
 * Read a run's transcript back, oldest first. Missing file → `[]`. Malformed
 * lines are skipped (a partially-flushed final line must not abort a read).
 */
export async function readRunTranscript(
  storage: TranscriptStorage,
  itemId: number,
  runId: string,
): Promise<RunTranscriptEvent[]> {
  // Defensive: a runId is interpolated into the file path, so reject anything
  // that could escape the namespace (engine run ids are UUIDs). The IPC layer
  // guards too — this protects every caller.
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return [];
  const path = runTranscriptPath(itemId, runId);
  if (!(await storage.exists(path))) return [];
  const text = await storage.readText(path);
  const events: RunTranscriptEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as RunTranscriptEvent);
    } catch {
      // skip a torn final line
    }
  }
  return events;
}
