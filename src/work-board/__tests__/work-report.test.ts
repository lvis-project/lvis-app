/**
 * Host report generation contract — daily + weekly.
 *
 * Verifies: empty board / empty week short-circuit with NO LLM call; a
 * populated board calls the LLM once, persists markdown under reports/, and
 * appends a one-line memory summary; an LLM failure propagates (No-Fallback);
 * and generate(kind) dispatches correctly. Storage + store + LLM are in-memory
 * fakes; `now()` is injected so KST windows are deterministic.
 */
import { describe, it, expect } from "vitest";
import { createWorkBoardReporter } from "../work-report.js";
import { MEMORY_FILE } from "../work-memory.js";
import { okListReader } from "./board-test-fixtures.js";
import type { WorkBoardStorage } from "../storage.js";
import type {
  WorkItem,
  WorkItemResolved,
} from "../../shared/work-board-types.js";

// 2026-06-16T03:00:00Z == 12:00 KST, Tue → KST day "2026-06-16".
const NOW = Date.parse("2026-06-16T03:00:00.000Z");

function item(
  p: Partial<WorkItem> & { id: number; status_resolved?: WorkItemResolved["status_resolved"] },
): WorkItemResolved {
  const { status_resolved, ...rest } = p;
  const base: WorkItem = {
    title: `item ${p.id}`,
    status: "planned",
    priority: "medium",
    created_at: "2026-06-16T01:00:00.000Z", // 10:00 KST 16th — inside today + this week
    updated_at: "2026-06-16T01:00:00.000Z",
    ...rest,
  };
  return { ...base, status_resolved: status_resolved ?? base.status };
}

/** Full in-memory WorkBoardStorage. */
function memStorage(): WorkBoardStorage & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    readJson: async <T>(rel: string) => (rel in files ? (JSON.parse(files[rel]) as T) : null),
    writeJson: async (rel, value) => {
      files[rel] = JSON.stringify(value);
    },
    readText: async (rel) => files[rel] ?? "",
    write: async (rel, data) => {
      files[rel] = data;
    },
    exists: async (rel) => rel in files,
    mkdir: async () => {},
  };
}

function llmRecorder(reply = "# 리포트\n내용") {
  const calls: Array<{ prompt: string; system?: string }> = [];
  return {
    calls,
    callLlm: async (prompt: string, opts?: { systemPrompt?: string }) => {
      calls.push({ prompt, system: opts?.systemPrompt });
      return reply;
    },
  };
}

describe("work-report — daily", () => {
  it("empty board → empty envelope, no LLM call", async () => {
    const { callLlm, calls } = llmRecorder();
    const reporter = createWorkBoardReporter({ store: okListReader([]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generateDaily();
    expect(r.status).toBe("empty");
    expect(calls).toHaveLength(0);
  });

  it("invalid date → empty envelope, no LLM call", async () => {
    const { callLlm, calls } = llmRecorder();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generateDaily({ date: "2026-6-16" });
    expect(r).toMatchObject({ status: "empty", period: "2026-6-16" });
    expect(calls).toHaveLength(0);
  });

  it("populated board → ok, writes markdown, appends memory, one LLM call", async () => {
    const { callLlm, calls } = llmRecorder();
    const storage = memStorage();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage, callLlm, now: () => NOW });

    const r = await reporter.generateDaily();
    expect(r).toMatchObject({ status: "ok", kind: "daily", period: "2026-06-16", markdown: "# 리포트\n내용" });
    expect(calls).toHaveLength(1);
    expect(storage.files["reports/daily/2026-06-16.md"]).toBe("# 리포트\n내용");
    // Self-improvement: a one-line summary was appended to MEMORY.md.
    expect(storage.files[MEMORY_FILE]).toContain("2026-06-16:");
  });

  it("propagates an LLM failure (No-Fallback — no stub report)", async () => {
    const failing = async () => {
      throw new Error("provider down");
    };
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage: memStorage(), callLlm: failing, now: () => NOW });
    await expect(reporter.generateDaily()).rejects.toThrow("provider down");
  });
});

describe("work-report — weekly", () => {
  it("no activity this week → empty envelope, no LLM call", async () => {
    const { callLlm, calls } = llmRecorder();
    // Item created long ago + no completion this week → nothing in the window.
    const old = item({ id: 1, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
    const reporter = createWorkBoardReporter({ store: okListReader([old]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generateWeekly();
    expect(r.status).toBe("empty");
    expect(calls).toHaveLength(0);
  });

  it("rejects a traversal-bearing weekIso BEFORE any file write (security)", async () => {
    const { callLlm, calls } = llmRecorder();
    const storage = memStorage();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage, callLlm, now: () => NOW });

    const r = await reporter.generateWeekly({ weekIso: "../../etc/evil" });
    expect(r.status).toBe("empty"); // refused — not generated
    expect(calls).toHaveLength(0); // no LLM call
    // No file escaped the namespace (no write happened at all).
    expect(Object.keys(storage.files)).toHaveLength(0);
  });

  it("activity this week → ok, writes weekly markdown", async () => {
    const { callLlm, calls } = llmRecorder();
    const storage = memStorage();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage, callLlm, now: () => NOW });
    const r = await reporter.generateWeekly();
    expect(r.status).toBe("ok");
    expect(calls).toHaveLength(1);
    if (r.status === "ok") {
      expect(storage.files[`reports/weekly/${r.period}.md`]).toBe("# 리포트\n내용");
    }
  });
});

describe("work-report — dispatch", () => {
  it("generate('weekly') routes to the weekly handler", async () => {
    const { callLlm } = llmRecorder();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generate("weekly");
    expect(r.kind).toBe("weekly");
  });

  it("generate('daily') routes to the daily handler", async () => {
    const { callLlm } = llmRecorder();
    const reporter = createWorkBoardReporter({ store: okListReader([item({ id: 1 })]), storage: memStorage(), callLlm, now: () => NOW });
    const r = await reporter.generate("daily");
    expect(r.kind).toBe("daily");
  });
});
