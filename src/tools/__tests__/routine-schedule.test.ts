/**
 * `routine_schedule` tool — `source` marker stamping.
 *
 * Verifies that the LLM-facing `source` field is threaded through to the
 * persisted record (the accept-path that stamps the idempotency identity), and
 * that the length cap is enforced at the tool boundary.
 */
import { describe, it, expect } from "vitest";

import { createRoutineScheduleTool } from "../routine-schedule.js";
import { MAX_ROUTINE_SOURCE_LENGTH } from "../../main/routines-store.js";
import { futureIso, tempRoutinesStore } from "../../main/__tests__/routines-fixture.js";
import { toolExecutionContext as ctx } from "./tool-context-fixture.js";


describe("routine_schedule tool — source marker", () => {
  it("stamps the source marker onto the persisted routine", async () => {
    const { store, cleanup } = tempRoutinesStore();
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
    const { store, cleanup } = tempRoutinesStore();
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
    const { store, cleanup } = tempRoutinesStore();
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
