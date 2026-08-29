/**
 * `routine_schedule` tool — `source` marker stamping.
 *
 * Verifies that the LLM-facing `source` field is threaded through to the
 * persisted record (the accept-path that stamps the idempotency identity), and
 * that the length cap is enforced at the tool boundary.
 */
import { describe, it, expect } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRoutineScheduleTool } from "../routine-schedule.js";
import {
  MAX_CRON_EXPR_LENGTH,
  MAX_ROUTINE_SOURCE_LENGTH,
  MIN_INTERVAL_MS,
  RoutinesStore,
} from "../../main/routines-store.js";
import type { ToolExecutionContext } from "../base.js";

const ctx = (): ToolExecutionContext => ({ cwd: "/tmp", extraAllowedDirectories: [], metadata: {} });

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "lvis-routine-tool-"));
  const store = new RoutinesStore(join(dir, "routines.json"));
  const cleanup = () => cleanupTmpDir(dir);
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
      await cleanup();
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
      await cleanup();
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
      await cleanup();
    }
  });
});

describe("routine_schedule tool — validation bounds shared with the store", () => {
  it("rejects a cron expression one character past the store's cap", async () => {
    const { store, cleanup } = tempStore();
    try {
      const tool = createRoutineScheduleTool(store);
      // A valid expression of exactly `length` characters: a minute list padded
      // with repeats of the same minute (whitespace would be trimmed away).
      const cronOfLength = (length: number): string => {
        let minutes = (length - " 9 * * 1".length) % 2 === 0 ? "00" : "0";
        while (minutes.length + " 9 * * 1".length < length) minutes += ",0";
        return `${minutes} 9 * * 1`;
      };
      const atCap = cronOfLength(MAX_CRON_EXPR_LENGTH);
      const pastCap = cronOfLength(MAX_CRON_EXPR_LENGTH + 1);
      expect(atCap).toHaveLength(MAX_CRON_EXPR_LENGTH);
      expect(pastCap).toHaveLength(MAX_CRON_EXPR_LENGTH + 1);
      const run = (expression: string) => tool.execute(
        { execution: "notification-only", schedule: { repeat: { kind: "cron", expression } }, notificationTitle: "cron" },
        ctx(),
      );
      expect((await run(atCap)).isError).toBe(false);
      expect((await run(pastCap)).isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("persists an interval at the store's minimum and drops one a millisecond under it", async () => {
    const { store, cleanup } = tempStore();
    try {
      const tool = createRoutineScheduleTool(store);
      const persistedRepeat = async (intervalMs: number) => {
        const result = await tool.execute(
          { execution: "notification-only", schedule: { at: futureIso(), repeat: { kind: "interval", intervalMs } }, notificationTitle: "interval" },
          ctx(),
        );
        expect(result.isError).toBe(false);
        const routineId = JSON.parse(result.output).routineId as string;
        return store.list().find((r) => r.id === routineId)?.schedule?.repeat;
      };
      expect(await persistedRepeat(MIN_INTERVAL_MS)).toEqual({ kind: "interval", intervalMs: MIN_INTERVAL_MS });
      expect(await persistedRepeat(MIN_INTERVAL_MS - 1)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
