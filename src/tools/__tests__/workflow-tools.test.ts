/**
 * Unit tests for the 5 workflow system tools (S1+S2):
 * ask_user_question, schedule_routine, todo_session_write, agent_spawn, skill_load.
 *
 * Each test stubs the service dependency and exercises the tool's
 * `execute(rawInput, ctx)` contract directly — no Electron / IPC.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolExecutionContext } from "../base.js";
import { createAskUserQuestionTool } from "../ask-user-question.js";
import { createScheduleRoutineTool } from "../schedule-routine.js";
import { createTodoSessionWriteTool } from "../todo-session-write.js";
import { createAgentSpawnTool } from "../agent-spawn.js";
import { createSkillLoadTool } from "../skill-load.js";
import { RoutinesStore } from "../../main/routines-store.js";
import { SessionTodoStore } from "../../main/session-todo-store.js";
import { SkillStore } from "../../main/skill-store.js";
import { SkillOverlay } from "../../main/skill-overlay.js";

function ctx(sessionId = "session-x"): ToolExecutionContext {
  return { cwd: process.cwd(), metadata: { sessionId } };
}

describe("ask_user_question tool", () => {
  it("rejects when gate is missing", async () => {
    const tool = createAskUserQuestionTool({ getGate: () => undefined });
    const r = await tool.execute(
      { questions: [{ question: "Pick one" }] },
      ctx(),
    );
    expect(r.isError).toBe(true);
  });

  it("rejects empty questions[]", async () => {
    const tool = createAskUserQuestionTool({
      getGate: () => ({
        ask: () => Promise.resolve({ requestId: "r", answers: [] }),
      }) as never,
    });
    const r = await tool.execute({ questions: [] }, ctx());
    expect(r.isError).toBe(true);
  });

  it("rejects when any questions[].question is blank", async () => {
    const tool = createAskUserQuestionTool({
      getGate: () => ({
        ask: () => Promise.resolve({ requestId: "r", answers: [] }),
      }) as never,
    });
    const r = await tool.execute(
      { questions: [{ question: "  " }] },
      ctx(),
    );
    expect(r.isError).toBe(true);
  });

  it("rejects an unanswerable question (no choices and allowFreeText:false)", async () => {
    // Without choices AND with free-text disabled the renderer would
    // show no inputs at all; user could only dismiss. Guard at tool layer.
    const tool = createAskUserQuestionTool({
      getGate: () => ({
        ask: () => Promise.resolve({ requestId: "r", answers: [] }),
      }) as never,
    });
    const r = await tool.execute(
      { questions: [{ question: "Pick", allowFreeText: false }] },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.output).toContain("at least one input");
  });

  it("rejects when more than 4 questions are supplied", async () => {
    const tool = createAskUserQuestionTool({
      getGate: () => ({
        ask: () => Promise.resolve({ requestId: "r", answers: [] }),
      }) as never,
    });
    const r = await tool.execute(
      {
        questions: Array.from({ length: 5 }, (_, i) => ({ question: `q${i}` })),
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
  });

  it("forwards questions + returns answers[] verbatim", async () => {
    const ask = vi.fn().mockResolvedValue({
      requestId: "r1",
      answers: [{ choice: "yes" }, { freeText: "later" }],
      dismissed: false,
    });
    const tool = createAskUserQuestionTool({
      getGate: () => ({ ask }) as never,
    });
    const r = await tool.execute(
      {
        questions: [
          { question: "Continue?", choices: ["yes", "no"] },
          { question: "When?" },
        ],
      },
      ctx(),
    );
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.answers).toEqual([{ choice: "yes" }, { freeText: "later" }]);
    expect(parsed.dismissed).toBe(false);
    expect(ask).toHaveBeenCalledWith({
      questions: [
        { question: "Continue?", choices: ["yes", "no"], allowFreeText: true },
        { question: "When?", choices: undefined, allowFreeText: true },
      ],
      abortSignal: undefined,
    });
  });

  it("threads ctx.abortSignal into gate.ask", async () => {
    const ask = vi.fn().mockResolvedValue({ requestId: "r1", answers: [] });
    const tool = createAskUserQuestionTool({
      getGate: () => ({ ask }) as never,
    });
    const ac = new AbortController();
    await tool.execute(
      { questions: [{ question: "x" }] },
      { ...ctx(), abortSignal: ac.signal },
    );
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: ac.signal }),
    );
  });
});

describe("schedule_routine tool", () => {
  it("declares a literal-aware approval cache key for plugin scope", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-rt-"));
    try {
      const store = new RoutinesStore(join(tmp, "routines.json"));
      const tool = createScheduleRoutineTool(store);

      expect(tool.approvalCacheKey?.({ allowedPlugins: ["meeting", "local-indexer"] })).toBe(
        "scope:allow:local-indexer,meeting",
      );
      expect(tool.approvalCacheKey?.({ allowedPlugins: ["local-indexer", "meeting"] })).toBe(
        "scope:allow:local-indexer,meeting",
      );
      expect(tool.approvalCacheKey?.({ allowedPlugins: [] })).toBe("scope:deny-all");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing schedule.at for non-cron", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-rt-"));
    try {
      const store = new RoutinesStore(join(tmp, "routines.json"));
      const tool = createScheduleRoutineTool(store);
      const r = await tool.execute(
        { execution: "notification-only", schedule: { at: "not-a-date" }, notificationTitle: "x" },
        ctx(),
      );
      expect(r.isError).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("persists a notification-only routine and returns the id", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-rt-"));
    try {
      const store = new RoutinesStore(join(tmp, "routines.json"));
      const tool = createScheduleRoutineTool(store);
      const r = await tool.execute(
        {
          execution: "notification-only",
          schedule: { at: "2030-12-31T09:00:00+09:00", repeat: { kind: "daily" } },
          notificationTitle: "year-end",
        },
        ctx(),
      );
      expect(r.isError).toBe(false);
      const parsed = JSON.parse(r.output);
      expect(parsed.routineId).toMatch(/[0-9a-f-]{36}/);
      const list = store.listActive();
      expect(list).toHaveLength(1);
      expect(list[0].schedule?.repeat?.kind).toBe("daily");
      expect(list[0].notificationTitle).toBe("year-end");
      expect(list[0].scope?.pluginIds).toEqual({ mode: "deny-all" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts YYYY-MM-DD as KST 09:00", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-rt-"));
    try {
      const store = new RoutinesStore(join(tmp, "routines.json"));
      const tool = createScheduleRoutineTool(store);
      const r = await tool.execute(
        { execution: "notification-only", schedule: { at: "2030-01-01" }, notificationTitle: "newyear" },
        ctx(),
      );
      expect(r.isError).toBe(false);
      const list = store.listActive();
      // 2030-01-01 09:00 KST = 2030-01-01 00:00 UTC
      expect(list[0].schedule?.at).toBe("2030-01-01T00:00:00.000Z");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects llm-session without prePrompt", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-rt-"));
    try {
      const store = new RoutinesStore(join(tmp, "routines.json"));
      const tool = createScheduleRoutineTool(store);
      const r = await tool.execute(
        { execution: "llm-session", schedule: { at: "2030-01-01T09:00:00Z" } },
        ctx(),
      );
      expect(r.isError).toBe(true);
      expect(r.output).toContain("prePrompt");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("todo_session_write tool", () => {
  it("rejects empty items array", async () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    const r = await tool.execute({ items: [] }, ctx());
    expect(r.isError).toBe(true);
  });

  it("merges items by id and preserves order", async () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    const r1 = await tool.execute(
      {
        items: [
          { content: "step 1", status: "pending" },
          { content: "step 2", status: "pending" },
        ],
      },
      ctx("s1"),
    );
    const after1 = JSON.parse(r1.output).items as Array<{
      id: string;
      content: string;
      status: string;
    }>;
    expect(after1).toHaveLength(2);
    const firstId = after1[0].id;

    // Update step 1 to completed by id
    const r2 = await tool.execute(
      {
        items: [{ id: firstId, content: "step 1", status: "completed" }],
      },
      ctx("s1"),
    );
    const after2 = JSON.parse(r2.output).items as Array<{
      id: string;
      status: string;
    }>;
    expect(after2[0].id).toBe(firstId);
    expect(after2[0].status).toBe("completed");
    expect(after2[1].status).toBe("pending");
  });

  it("supports ordered insertion and deletion", async () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    const r1 = await tool.execute(
      {
        items: [
          { content: "step 1", status: "pending" },
          { content: "step 3", status: "pending" },
        ],
      },
      ctx("s-order"),
    );
    const after1 = JSON.parse(r1.output).items as Array<{ id: string; content: string }>;
    const step1 = after1[0];
    const step3 = after1[1];

    const r2 = await tool.execute(
      {
        items: [
          { content: "step 2", status: "pending", beforeId: step3.id },
        ],
      },
      ctx("s-order"),
    );
    const after2 = JSON.parse(r2.output).items as Array<{ id: string; content: string }>;
    expect(after2.map((i) => i.content)).toEqual(["step 1", "step 2", "step 3"]);

    const r3 = await tool.execute(
      {
        items: [
          { id: step1.id, status: "deleted" },
        ],
      },
      ctx("s-order"),
    );
    const after3 = JSON.parse(r3.output).items as Array<{ content: string }>;
    expect(after3.map((i) => i.content)).toEqual(["step 2", "step 3"]);
  });
});

describe("agent_spawn tool", () => {
  it("description forbids proxying direct Agent Hub tool calls", () => {
    const tool = createAgentSpawnTool({
      getRunner: () => undefined,
      emit: () => undefined,
    });
    expect(tool.description).toContain("직접 호출");
    expect(tool.description).toContain("Agent Hub work board");
    expect(tool.description).toContain("agent_hub_*");
  });

  it("rejects when runner is missing", async () => {
    const tool = createAgentSpawnTool({
      getRunner: () => undefined,
      emit: () => undefined,
    });
    const r = await tool.execute(
      { title: "t", instructions: "do stuff" },
      ctx(),
    );
    expect(r.isError).toBe(true);
  });

  it("forwards to runner and emits start/done events", async () => {
    const events: Array<{ type: string; spawnId: string }> = [];
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (input, callbacks) => {
          callbacks?.onTurn?.({ turn: 1, text: "hello", toolCallCount: 0 });
          return {
            summary: "done-text",
            toolCallCount: 0,
            turnCount: 1,
            childSessionId: "child-1",
          };
        },
      }) as never,
      emit: (e) => {
        events.push({ type: e.type, spawnId: e.spawnId });
      },
    });
    const r = await tool.execute(
      { title: "search", instructions: "find X" },
      ctx(),
    );
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.summary).toBe("done-text");
    expect(parsed.toolCallCount).toBe(0);
    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("done");
  });

  it("rejects missing title or instructions", async () => {
    const tool = createAgentSpawnTool({
      getRunner: () => ({ spawn: async () => ({}) }) as never,
      emit: () => undefined,
    });
    const r = await tool.execute({ title: "", instructions: "" }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe("skill_load tool", () => {
  // Built-in skills are pre-blessed: no approval gate is consulted, so we
  // can stub it with a never-called fn. User-authored skills exercise the
  // gate path — covered by the skill-store traversal tests below.
  const stubApprovals = {
    isApproved: async () => true,
    approve: async () => undefined,
  } as never;

  it("loads built-in report-writing skill and emits badge", async () => {
    const store = new SkillStore({});
    const overlay = new SkillOverlay();
    const events: string[] = [];
    const tool = createSkillLoadTool({
      store,
      overlay,
      approvals: stubApprovals,
      getApprovalGate: () => undefined,
      emit: (e) => events.push(e.name),
    });
    const r = await tool.execute({ skillName: "report-writing" }, ctx("sess-1"));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.loaded).toBe(true);
    expect(parsed.skillName).toBe("report-writing");
    expect(events).toEqual(["report-writing"]);
    // C2(c): the overlay carries the skill body for the next turn's
    // system prompt; previously this was a chat-history append.
    const overlaySection = overlay.buildSection("sess-1");
    expect(overlaySection).toContain("<lvis-skill name=\"report-writing\"");
    expect(overlaySection).toContain("</lvis-active-skills>");
  });

  it("returns error for missing skill", async () => {
    const store = new SkillStore({});
    const overlay = new SkillOverlay();
    const tool = createSkillLoadTool({
      store,
      overlay,
      approvals: stubApprovals,
      getApprovalGate: () => undefined,
      emit: () => undefined,
    });
    const r = await tool.execute({ skillName: "does-not-exist" }, ctx());
    expect(r.isError).toBe(true);
  });

  it("rejects names outside the allowlist before any FS access", async () => {
    const store = new SkillStore({});
    const overlay = new SkillOverlay();
    const tool = createSkillLoadTool({
      store,
      overlay,
      approvals: stubApprovals,
      getApprovalGate: () => undefined,
      emit: () => undefined,
    });
    const r = await tool.execute({ skillName: "../../etc/passwd" }, ctx());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.output);
    expect(parsed.error).toContain("invalid skillName");
  });
});
