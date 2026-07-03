/**
 * Shared work-board test fixtures.
 *
 * The due-soon and report unit tests both need a board reader stub returning a
 * fixed `ok` list (both consume the narrow `{ list(): Promise<WorkItemListResult> }`
 * seam). The implementation lives here once rather than being copy-pasted into
 * each test — the check:test-duplicates gate forbids duplicate helper bodies.
 */
import type { WorkItemListResult, WorkItemResolved } from "../../shared/work-board-types.js";
import type { TranscriptStorage } from "../run-transcript.js";

/** Board reader stub returning a fixed `ok` list (structurally satisfies the
 * narrow reader interfaces used by the due-soon scanner and the reporter). */
export function okListReader(
  items: WorkItemResolved[],
): { list(): Promise<WorkItemListResult> } {
  return { list: async () => ({ status: "ok", items }) };
}

/**
 * In-memory {@link TranscriptStorage} standing in for the work-board namespace
 * dir. Shared by the run-transcript unit tests and the engine's flooding
 * regression (both assert against the persisted JSONL) — the check:test-
 * duplicates gate forbids duplicate helper bodies, so it lives here once.
 */
export function memTranscriptStorage(): TranscriptStorage & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    readText: async (rel) => files[rel] ?? "",
    write: async (rel, data) => {
      files[rel] = data;
    },
    exists: async (rel) => rel in files,
    mkdir: async () => {},
  };
}
