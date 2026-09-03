/**
 * Shared work-board test fixtures.
 *
 * The due-soon and report unit tests both need a board reader stub returning a
 * fixed `ok` list (both consume the narrow `{ list(): Promise<WorkItemListResult> }`
 * seam). The implementation lives here once rather than being copy-pasted into
 * each test — the check:test-duplicates gate forbids duplicate helper bodies.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalChoice, ApprovalDecision, ApprovalGate } from "../../permissions/approval-gate.js";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
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

export function projectMemoryPath(files: Record<string, string>): string | undefined {
  return Object.keys(files).find((key) => key.startsWith("memories/projects/") && key.endsWith("/MEMORY.md"));
}

export function projectReportPath(files: Record<string, string>, kind: "daily" | "weekly"): string | undefined {
  return Object.keys(files).find((key) => key.startsWith("reports/projects/") && key.includes(`/${kind}/`));
}

/**
 * A {@link WorkBoardStore} over a board file in its own scratch directory,
 * with the teardown that removes it.
 *
 * The engine suites drive a real store rather than a stub — persistence is
 * what they assert — and each test takes a fresh board, so `cleanup` is
 * returned rather than registered: the suites call it in a `finally` around
 * the run they are asserting on.
 */
export function tempBoardStore(): {
  store: WorkBoardStore;
  cleanup: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "lvis-work-board-"));
  return {
    store: new WorkBoardStore(join(dir, "board.json")),
    cleanup: () => cleanupTmpDir(dir),
  };
}

/**
 * An {@link ApprovalGate} that answers every request with `choice` and keeps
 * what it was asked.
 *
 * The engine treats the gate as a one-shot oracle, so the scripted choice is
 * the whole seam; the recorded requests are how a suite asserts on what the
 * engine put in front of the user.
 */
export function scriptedApprovalGate(choice: ApprovalChoice): {
  gate: ApprovalGate;
  requests: unknown[];
} {
  const requests: unknown[] = [];
  const gate = {
    async requestAndWait(request: unknown): Promise<ApprovalDecision> {
      requests.push(request);
      return { requestId: "scripted-gate-request", choice };
    },
  } as unknown as ApprovalGate;
  return { gate, requests };
}
