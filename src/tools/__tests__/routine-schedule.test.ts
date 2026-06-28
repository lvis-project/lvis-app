/**
 * `routine_schedule` tool — `source` marker stamping.
 *
 * Verifies that the LLM-facing `source` field is threaded through to the
 * persisted record (the accept-path that stamps the idempotency identity), and
 * that the length cap is enforced at the tool boundary.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRoutineScheduleTool } from "../routine-schedule.js";
import { RoutinesStore, MAX_ROUTINE_SOURCE_LENGTH } from "../../main/routines-store.js";
import type { ToolExecutionContext } from "../base.js";

const ctx = (): ToolExecutionContext => ({ cwd: "/tmp", extraAllowedDirectories: [], metadata: {} });

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "lvis-routine-tool-"));
  const store = new RoutinesStore(join(dir, "routines.json"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { store, cleanup };
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("routine_schedule tool — source marker", () => {
  it("stamps the source marker onto the persisted routine", async () => {
    const { store, cleanup } = tempStore();
    try {
      const tool = createRoutineScheduleTool(store);
      const result = await tool.execute(
        {
          execution: "llm-session",
          schedule: { at: futureIso(), repeat: { kind: "daily" } },
          prePrompt: "야간 재스캔",
          source: "suggestion:local-indexer:nightly-rescan",
        },
        ctx(),
      );
      expect(result.isError).toBe(false);
      const routineId = JSON.parse(result.output).routineId as string;
      const record = store.list().find((r) => r.id === routineId);
      expect(record?.source).toBe("suggestion:local-indexer:nightly-rescan");
    } finally {
      cleanup();
    }
  });

  it("leaves source unset when omitted", async () => {
    const { store, cleanup } = tempStore();
    try {
      const tool = createRoutineScheduleTool(store);
      const result = await tool.execute(
        {
          execution: "notification-only",
          schedule: { at: futureIso() },
          notificationTitle: "manual",
        },
        ctx(),
      );
      expect(result.isError).toBe(false);
      const routineId = JSON.parse(result.output).routineId as string;
      expect(store.list().find((r) => r.id === routineId)?.source).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rejects a source longer than the cap with a clean tool error", async () => {
    const { store, cleanup } = tempStore();
    try {
      const tool = createRoutineScheduleTool(store);
      const result = await tool.execute(
        {
          execution: "notification-only",
          schedule: { at: futureIso() },
          notificationTitle: "too-long",
          source: "x".repeat(MAX_ROUTINE_SOURCE_LENGTH + 1),
        },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("source must be at most");
      // Nothing should have been persisted.
      expect(store.list()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
