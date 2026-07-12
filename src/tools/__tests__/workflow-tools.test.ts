/**
 * Unit tests for workflow system tools (S1+S2):
 * ask_user_question, routine_schedule, todo_session_write, agent_spawn,
 * agent_status, agent_interrupt, skill_load.
 *
 * Each test stubs the service dependency and exercises the tool's
 * `execute(rawInput, ctx)` contract directly — no Electron / IPC.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolvePath(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../..",
);
const BUILTIN_SKILLS_DIR = resolvePath(REPO_ROOT, "resources/skills");
import type { ToolExecutionContext } from "../base.js";
import { createAskUserQuestionTool } from "../ask-user-question.js";
import { createRoutineScheduleTool } from "../routine-schedule.js";
import { createTodoSessionWriteTool } from "../todo-session-write.js";
import {
  createAgentInterruptTool,
  createAgentSpawnTool,
  createAgentStatusTool,
} from "../agent-spawn.js";
import type { AgentSpawnEvent } from "../../shared/subagent-events.js";
import { createSkillLoadTool } from "../skill-load.js";
import { createSkillListTool } from "../skill-list.js";
import { createAgentListTool } from "../agent-list.js";
import { RoutinesStore } from "../../main/routines-store.js";
import { SessionTodoStore } from "../../main/session-todo-store.js";
import { SkillStore } from "../../main/skill-store.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { AgentProfileStore } from "../../main/agent-profile-store.js";
import { ToolRegistry, TOOL_SEARCH_TOOL_NAME } from "../registry.js";
import { registerRequestPluginMetaTool, registerToolSearchMetaTool } from "../../boot/tools.js";

function ctx(sessionId = "session-x"): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    metadata: { sessionId, supportsA2AParentDelivery: true },
  };
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

describe("routine_schedule tool", () => {
  it("declares a literal-aware approval cache key for plugin scope", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-rt-"));
    try {
      const store = new RoutinesStore(join(tmp, "routines.json"));
      const tool = createRoutineScheduleTool(store);

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
      const tool = createRoutineScheduleTool(store);
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
      const tool = createRoutineScheduleTool(store);
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
      const tool = createRoutineScheduleTool(store);
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
      const tool = createRoutineScheduleTool(store);
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
  it("description anti-claims user task registration requests (issue #648)", () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    expect(tool.description).toContain("영구 업무 항목 등록");
    expect(tool.description).toContain("내부 단계 추적");
    expect(tool.description).toContain("사용하지 마세요");
  });

  it("rejects empty items array", async () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    const r = await tool.execute({ items: [] }, ctx());
    expect(r.isError).toBe(true);
  });

  it("rejects execution when session metadata is missing", async () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    const r = await tool.execute(
      { items: [{ content: "step", status: "pending" }] },
      { cwd: process.cwd(), extraAllowedDirectories: [], metadata: {} },
    );
    expect(r.isError).toBe(true);
    expect(r.output).toContain("missing sessionId metadata");
    expect(store.list("unknown")).toEqual([]);
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

  it("rejects a no-op re-mark without mutating the store", async () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    const r1 = await tool.execute(
      { items: [{ content: "step 1", status: "in_progress" }] },
      ctx("s-noop"),
    );
    const id = (JSON.parse(r1.output).items as Array<{ id: string }>)[0].id;
    const writeSpy = vi.spyOn(store, "write");

    // Re-mark the already-in_progress item in_progress → nothing changes.
    const r2 = await tool.execute(
      { items: [{ id, status: "in_progress" }] },
      ctx("s-noop"),
    );
    const body = JSON.parse(r2.output);
    expect(r2.isError).toBe(true);
    expect(body.changed).toBe(false);
    expect(body.error).toContain("Do not retry todo_session_write");
    // Fail-safe: a no-op call never reaches the store.
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("still writes when at least one item actually advances", async () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    const r1 = await tool.execute(
      {
        items: [
          { content: "step 1", status: "in_progress" },
          { content: "step 2", status: "pending" },
        ],
      },
      ctx("s-adv"),
    );
    const items = JSON.parse(r1.output).items as Array<{ id: string }>;
    const writeSpy = vi.spyOn(store, "write");

    // step 1 -> completed (real change) alongside a no-op re-mark of step 2.
    const r2 = await tool.execute(
      {
        items: [
          { id: items[0].id, status: "completed" },
          { id: items[1].id, status: "pending" },
        ],
      },
      ctx("s-adv"),
    );
    const body = JSON.parse(r2.output);
    expect(body.changed).toBeUndefined();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(body.items[0].status).toBe("completed");
    writeSpy.mockRestore();
  });

  it("treats deleting a non-existent item as a no-op", async () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    const writeSpy = vi.spyOn(store, "write");
    const r = await tool.execute(
      { items: [{ id: "ghost", status: "deleted" }] },
      ctx("s-del"),
    );
    const body = JSON.parse(r.output);
    expect(r.isError).toBe(false);
    expect(body.changed).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
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

  it("rejects deleting every session todo item", async () => {
    const store = new SessionTodoStore();
    const tool = createTodoSessionWriteTool(store);
    const r1 = await tool.execute(
      {
        items: [{ content: "step 1", status: "pending" }],
      },
      ctx("s-delete-all"),
    );
    const [step1] = JSON.parse(r1.output).items as Array<{ id: string; content: string }>;

    const r2 = await tool.execute(
      {
        items: [{ id: step1.id, status: "deleted" }],
      },
      ctx("s-delete-all"),
    );

    expect(r2.isError).toBe(true);
    expect(r2.output).toContain("cannot delete every item");
    expect(store.list("s-delete-all").map((item) => item.content)).toEqual(["step 1"]);
  });
});

describe("agent_spawn tool", () => {
  it("description forbids proxying direct plugin tool calls", () => {
    const tool = createAgentSpawnTool({
      getRunner: () => undefined,
      emit: () => undefined,
    });
    expect(tool.parallelSafe).toBe(true);
    expect(tool.description).toContain("직접 호출");
    expect(tool.description).toContain("request_plugin");
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

  it.each([undefined, false])("fails closed before runner lookup when background parent delivery is %s", async (capability) => {
    const getRunner = vi.fn();
    const emit = vi.fn();
    const tool = createAgentSpawnTool({ getRunner, emit });
    const metadata: Record<string, unknown> = { sessionId: "session-x" };
    if (capability !== undefined) metadata.supportsA2AParentDelivery = capability;

    const result = await tool.execute(
      {
        title: "background",
        instructions: "work",
        background: true,
        supportsA2AParentDelivery: true,
      },
      { cwd: process.cwd(), extraAllowedDirectories: [], metadata },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      error: "background-parent-unsupported",
      message: "Background sub-agent delivery is unavailable for this conversation surface.",
      taskState: "TASK_STATE_REJECTED",
    });
    expect(getRunner).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps the spawn-depth hard stop ahead of background capability checks", async () => {
    const getRunner = vi.fn();
    const emit = vi.fn();
    const tool = createAgentSpawnTool({ getRunner, emit });
    const result = await tool.execute(
      { title: "nested", instructions: "work", background: true },
      {
        cwd: process.cwd(),
        extraAllowedDirectories: [],
        metadata: { sessionId: "session-x", spawnDepth: 1 },
      },
    );

    expect(JSON.parse(result.output)).toMatchObject({
      error: "agent_spawn cannot be invoked from a sub-agent",
      taskState: "TASK_STATE_REJECTED",
    });
    expect(getRunner).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it("forwards to runner and emits start/done events", async () => {
    const events: Array<{ type: string; spawnId: string }> = [];
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (input, callbacks) => {
          callbacks?.onActivity?.({
            entries: [{ kind: "assistant", text: "hello", streaming: false }],
            toolCallCount: 0,
          });
          return {
            summary: "done-text",
            toolCallCount: 0,
            turnCount: 1,
            childSessionId: "child-1",
            entries: [{ kind: "assistant", text: "done-text", streaming: false }],
            ok: true,
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
    expect(parsed.childSessionId).toBe("child-1");
    expect(parsed.entries).toBeUndefined();
    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    // PR3: activity events carry the live ChatEntry[] snapshot.
    expect(types).toContain("activity");
    expect(types).toContain("done");
  });

  it("treats a structurally returned blocked foreground run as rejected/error", async () => {
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async () => ({
          summary: "prompt refused",
          toolCallCount: 0,
          turnCount: 0,
          childSessionId: "child-blocked",
          entries: [],
          ok: true,
          stopReason: "blocked" as const,
        }),
      }) as never,
      emit: (event) => events.push(event),
    });

    const result = await tool.execute(
      { title: "blocked", instructions: "attempt work" },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      error: "prompt refused",
      taskState: "TASK_STATE_REJECTED",
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      status: "error",
      taskState: "TASK_STATE_REJECTED",
      message: "prompt refused",
      childSessionId: "child-blocked",
    });
  });
  it("preserves a budget suspension in the tool result and renders the done event as waiting", async () => {
    const events: AgentSpawnEvent[] = [];
    const deliverToParent = vi.fn();
    const suspension = {
      reason: "budget" as const,
      resumeId: "child-waiting",
    };
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async () => ({
          summary: "partial work",
          toolCallCount: 2,
          turnCount: 30,
          childSessionId: "child-waiting",
          entries: [],
          ok: true,
          stopReason: "round-cap" as const,
          suspension,
          incomplete: true,
        }),
        deliverToParent,
      }) as never,
      emit: (event) => events.push(event),
    });

    const result = await tool.execute(
      { title: "budgeted", instructions: "work until the assigned budget" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      incomplete: true,
      resumeId: "child-waiting",
      suspension,
    });
    expect(events.find((event) => event.type === "done")).toMatchObject({
      status: "waiting",
      suspension,
    });
    expect(deliverToParent).not.toHaveBeenCalled();
  });
  it("emits only INPUT_REQUIRED when a foreground diagnostic precedes a budget suspension", async () => {
    const events: AgentSpawnEvent[] = [];
    const suspension = {
      reason: "budget" as const,
      resumeId: "child-diagnostic-waiting",
    };
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (_input, callbacks) => {
          callbacks?.onLinked?.({ childSessionId: suspension.resumeId });
          callbacks?.onError?.("round cap reached");
          return {
            summary: "partial work",
            toolCallCount: 1,
            turnCount: 2,
            childSessionId: suspension.resumeId,
            entries: [],
            ok: true,
            stopReason: "round-cap" as const,
            suspension,
            incomplete: true,
          };
        },
      }) as never,
      emit: (event) => events.push(event),
    });

    const result = await tool.execute(
      { title: "diagnostic-waiting", instructions: "work" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const terminalEvents = events.filter(
      (event) => event.type === "done" || event.type === "error",
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      type: "done",
      taskState: "TASK_STATE_INPUT_REQUIRED",
      status: "waiting",
      suspension,
    });
  });

  it("emits only REJECTED when a foreground diagnostic precedes resume exhaustion", async () => {
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        resume: async (_id, _instructions, _title, callbacks) => {
          callbacks?.onLinked?.({ childSessionId: "child-resume-exhausted" });
          callbacks?.onError?.("resume exhausted");
          return {
            summary: "resume exhausted",
            error: "resume exhausted",
            toolCallCount: 0,
            turnCount: 0,
            childSessionId: "child-resume-exhausted",
            entries: [],
            ok: false,
            resumeExhausted: true,
          };
        },
      }) as never,
      emit: (event) => events.push(event),
    });

    const result = await tool.execute(
      {
        title: "resume-exhausted",
        instructions: "continue",
        resumeId: "child-resume-exhausted",
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      error: "resume exhausted",
      taskState: "TASK_STATE_REJECTED",
    });
    const terminalEvents = events.filter(
      (event) => event.type === "done" || event.type === "error",
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      type: "error",
      taskState: "TASK_STATE_REJECTED",
      status: "error",
      message: "resume exhausted",
    });
  });
  it("background mode returns a handle immediately and emits terminal event later", async () => {
    let resolveSpawn!: (value: {
      summary: string;
      toolCallCount: number;
      turnCount: number;
      childSessionId: string;
      entries: [];
      ok: true;
    }) => void;
    const spawnPromise = new Promise<{
      summary: string;
      toolCallCount: number;
      turnCount: number;
      childSessionId: string;
      entries: [];
      ok: true;
    }>((resolve) => {
      resolveSpawn = resolve;
    });
    const events: AgentSpawnEvent[] = [];
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "delivered-message",
    }));
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (input, callbacks) => {
          expect(input.spawnId).toBeTruthy();
          callbacks?.onLinked?.({ childSessionId: "child-bg" });
          callbacks?.onActivity?.({ entries: [], toolCallCount: 0 });
          return await spawnPromise;
        },
        deliverToParent,
      }) as never,
      emit: (event) => events.push(event),
    });

    const r = await tool.execute(
      { title: "bg", instructions: "work in background", background: true },
      ctx(),
    );

    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.background).toBe(true);
    expect(parsed.status).toBe("running");
    expect(parsed.taskState).toBe("TASK_STATE_SUBMITTED");
    expect(parsed.spawnId).toBeTruthy();
    expect(parsed.childSessionId).toBe("child-bg");
    expect(events.map((event) => [event.type, event.taskState])).toEqual([
      ["start", "TASK_STATE_SUBMITTED"],
      ["activity", "TASK_STATE_SUBMITTED"],
      ["activity", "TASK_STATE_WORKING"],
    ]);

    resolveSpawn({
      summary: "done later",
      toolCallCount: 0,
      turnCount: 1,
      childSessionId: "child-bg",
      entries: [],
      ok: true,
    });
    const deadline = Date.now() + 1000;
    while (!events.some((event) => event.type === "done") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(events.at(-1)).toMatchObject({
      type: "done",
      taskState: "TASK_STATE_COMPLETED",
      status: "done",
      spawnId: parsed.spawnId,
      childSessionId: "child-bg",
    });
    expect(deliverToParent).toHaveBeenCalledTimes(1);
    expect(deliverToParent).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: "session-x",
      childSessionId: "child-bg",
      message: expect.objectContaining({
        contextId: "session-x",
        taskId: "child-bg",
        role: "ROLE_AGENT",
        parts: [{ text: "done later" }],
        metadata: expect.objectContaining({
          taskState: "TASK_STATE_COMPLETED",
          spawnId: parsed.spawnId,
        }),
      }),
    }));
  });

  it("terminalizes a linked background rejection as FAILED and delivers it exactly once", async () => {
    const events: AgentSpawnEvent[] = [];
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "failed-message",
    }));
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (_input, callbacks) => {
          callbacks?.onLinked?.({ childSessionId: "child-rejected-promise" });
          callbacks?.onError?.("metadata setup failed");
          throw new Error("metadata setup failed");
        },
        deliverToParent,
      }) as never,
      emit: (event) => events.push(event),
    });

    const handle = await tool.execute(
      { title: "reject", instructions: "fail during setup", background: true },
      ctx(),
    );
    expect(handle.isError).toBe(false);

    const deadline = Date.now() + 1000;
    while (deliverToParent.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const terminalEvents = events.filter((event) => event.type === "done" || event.type === "error");
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      type: "error",
      taskState: "TASK_STATE_FAILED",
      status: "error",
      message: "metadata setup failed",
      childSessionId: "child-rejected-promise",
    });
    expect(deliverToParent).toHaveBeenCalledTimes(1);
    expect(deliverToParent).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: "session-x",
      childSessionId: "child-rejected-promise",
      message: expect.objectContaining({
        contextId: "session-x",
        taskId: "child-rejected-promise",
        metadata: expect.objectContaining({ taskState: "TASK_STATE_FAILED" }),
      }),
    }));
  });

  it("keeps a successful terminal event final when parent delivery rejects", async () => {
    const events: AgentSpawnEvent[] = [];
    const deliverToParent = vi.fn(async () => {
      throw new Error("delivery unavailable");
    });
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (_input, callbacks) => {
          callbacks?.onLinked?.({ childSessionId: "child-delivery-reject" });
          return {
            summary: "completed before delivery",
            toolCallCount: 0,
            turnCount: 1,
            childSessionId: "child-delivery-reject",
            entries: [],
            ok: true as const,
          };
        },
        deliverToParent,
      }) as never,
      emit: (event) => events.push(event),
    });

    const handle = await tool.execute(
      { title: "delivery", instructions: "complete", background: true },
      ctx(),
    );
    expect(handle.isError).toBe(false);

    const deadline = Date.now() + 1000;
    while (deliverToParent.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.resolve();

    expect(deliverToParent).toHaveBeenCalledTimes(1);
    const terminalEvents = events.filter((event) => event.type === "done" || event.type === "error");
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      type: "done",
      taskState: "TASK_STATE_COMPLETED",
      status: "done",
      childSessionId: "child-delivery-reject",
    });
  });

  it.each([
    [
      "waiting",
      {
        summary: "partial work",
        toolCallCount: 1,
        turnCount: 30,
        childSessionId: "child-state",
        entries: [],
        ok: true,
        stopReason: "round-cap",
        suspension: { reason: "budget", resumeId: "child-state" },
        incomplete: true,
      },
      "TASK_STATE_INPUT_REQUIRED",
    ],
    [
      "failed",
      {
        summary: "failed work",
        error: "provider failed",
        toolCallCount: 0,
        turnCount: 0,
        childSessionId: "child-state",
        entries: [],
        ok: false,
      },
      "TASK_STATE_FAILED",
    ],
    [
      "rejected",
      {
        summary: "resume rejected",
        error: "resume exhausted",
        toolCallCount: 0,
        turnCount: 0,
        childSessionId: "child-state",
        entries: [],
        ok: false,
        resumeExhausted: true,
      },
      "TASK_STATE_REJECTED",
    ],
  ] as const)("background mode delivers %s exactly once with its A2A task state", async (
    _label,
    spawnResult,
    expectedState,
  ) => {
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "state-message",
    }));
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (_input, callbacks) => {
          callbacks?.onLinked?.({ childSessionId: spawnResult.childSessionId });
          return spawnResult;
        },
        deliverToParent,
      }) as never,
      emit: vi.fn(),
    });

    const handle = await tool.execute(
      { title: "state", instructions: "project state", background: true },
      ctx(),
    );
    expect(handle.isError).toBe(false);

    const deadline = Date.now() + 1000;
    while (deliverToParent.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(deliverToParent).toHaveBeenCalledTimes(1);
    const delivery = deliverToParent.mock.calls[0]![0];
    expect(delivery.parentSessionId).toBe("session-x");
    expect(delivery.childSessionId).toBe("child-state");
    expect(delivery.message.contextId).toBe("session-x");
    expect(delivery.message.taskId).toBe("child-state");
    expect(delivery.message.role).toBe("ROLE_AGENT");
    if (expectedState === "TASK_STATE_INPUT_REQUIRED") {
      expect(delivery.message.parts[0]?.text).toContain("Input required");
    }
    expect(delivery.message.metadata).toMatchObject({
      taskState: expectedState,
      ...(expectedState === "TASK_STATE_INPUT_REQUIRED"
        ? { suspension: { reason: "budget", resumeId: "child-state" } }
        : {}),
    });
  });
  it("emits blocked background runs as rejected errors and still pushes the Message", async () => {
    const events: AgentSpawnEvent[] = [];
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "blocked-message",
    }));
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (_input, callbacks) => {
          callbacks?.onLinked?.({ childSessionId: "child-blocked-bg" });
          return {
            summary: "prompt refused",
            toolCallCount: 0,
            turnCount: 0,
            childSessionId: "child-blocked-bg",
            entries: [],
            ok: true,
            stopReason: "blocked" as const,
          };
        },
        deliverToParent,
      }) as never,
      emit: (event) => events.push(event),
    });

    const handle = await tool.execute(
      { title: "blocked", instructions: "attempt work", background: true },
      ctx(),
    );
    expect(handle.isError).toBe(false);

    const deadline = Date.now() + 1000;
    while (deliverToParent.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(events.at(-1)).toMatchObject({
      type: "error",
      status: "error",
      taskState: "TASK_STATE_REJECTED",
      message: "prompt refused",
      childSessionId: "child-blocked-bg",
    });
    expect(deliverToParent).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: "session-x",
      childSessionId: "child-blocked-bg",
      message: expect.objectContaining({
        metadata: expect.objectContaining({
          taskState: "TASK_STATE_REJECTED",
        }),
      }),
    }));
  });
  it("background mode preserves interrupted status through interrupt, status, and terminal event", async () => {
    let spawnId = "";
    let resolveSpawn!: () => void;
    const spawnPromise = new Promise<{
      summary: string;
      toolCallCount: number;
      turnCount: number;
      childSessionId: string;
      entries: [];
      ok: true;
      stopReason: "interrupted";
    }>((resolve) => {
      resolveSpawn = () =>
        resolve({
          summary: "stopped",
          toolCallCount: 0,
          turnCount: 1,
          childSessionId: "child-bg",
          entries: [],
          ok: true,
          stopReason: "interrupted",
        });
    });
    const run = {
      spawnId: "",
      childSessionId: "child-bg",
      title: "Interruptible",
      status: "running" as "running" | "interrupted",
      startedAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      toolCallCount: 0,
      turnCount: 0,
      entries: [],
    };
    const events: Array<{ type: string; spawnId: string; status?: string; childSessionId?: string }> = [];
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "interrupted-message",
    }));
    const runner = {
      spawn: async (input, callbacks) => {
        spawnId = input.spawnId ?? "";
        run.spawnId = spawnId;
        callbacks?.onLinked?.({ childSessionId: "child-bg" });
        return await spawnPromise;
      },
      deliverToParent,
      listRunStatuses: (originSessionId: string) => (originSessionId === "session-x" ? [run] : []),
      getRunStatus: (id: string, originSessionId: string) =>
        id === spawnId && originSessionId === "session-x" ? run : null,
      interruptRun: (id: string, originSessionId: string) => {
        if (id !== spawnId || originSessionId !== "session-x") return { ok: false, message: "not found" };
        run.status = "interrupted";
        run.updatedAt = "2026-07-07T00:00:01.000Z";
        resolveSpawn();
        return { ok: true, message: "interrupt requested", run };
      },
    };
    const spawnTool = createAgentSpawnTool({
      getRunner: () => runner as never,
      emit: (event) => {
        events.push({
          type: event.type,
          spawnId: event.spawnId,
          ...(event.status ? { status: event.status } : {}),
          ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
        });
      },
    });
    const interruptTool = createAgentInterruptTool({ getRunner: () => runner as never });
    const statusTool = createAgentStatusTool({ getRunner: () => runner as never });

    const spawned = await spawnTool.execute(
      { title: "bg", instructions: "work in background", background: true },
      ctx(),
    );
    const handle = JSON.parse(spawned.output);
    expect(handle.status).toBe("running");

    const interrupt = JSON.parse((await interruptTool.execute({ id: handle.spawnId }, ctx())).output);
    expect(interrupt.ok).toBe(true);
    expect(interrupt.run.status).toBe("interrupted");

    const status = JSON.parse((await statusTool.execute({ id: handle.spawnId }, ctx())).output);
    expect(status.run.status).toBe("interrupted");

    const deadline = Date.now() + 1000;
    while (!events.some((event) => event.type === "done") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(events.at(-1)).toMatchObject({
      type: "done",
      spawnId: handle.spawnId,
      childSessionId: "child-bg",
      status: "interrupted",
    });
    expect(deliverToParent).toHaveBeenCalledTimes(1);
    expect(deliverToParent).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        metadata: expect.objectContaining({ taskState: "TASK_STATE_CANCELED" }),
      }),
    }));
  });

  it("emits the child entries snapshot on done and activity events without embedding it in the tool result", async () => {
    const spawnEvents: Array<{ type: string; entries?: unknown[] }> = [];
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (input, callbacks) => {
          callbacks?.onActivity?.({
            entries: [
              {
                kind: "tool_group",
                groupId: "g",
                groupIds: ["g"],
                status: "done",
                tools: [
                  { toolUseId: "c1", name: "read_file", displayOrder: 0, status: "done", result: "x" },
                ],
              },
            ],
            toolCallCount: 1,
          });
          return {
            summary: "final",
            toolCallCount: 1,
            turnCount: 1,
            childSessionId: "child-1",
            entries: [
              {
                kind: "tool_group",
                groupId: "g",
                groupIds: ["g"],
                status: "done",
                tools: [
                  { toolUseId: "c1", name: "read_file", displayOrder: 0, status: "done", result: "x" },
                ],
              },
              { kind: "assistant", text: "final", streaming: false },
            ],
            ok: true,
          };
        },
      }) as never,
      emit: (e) => {
        spawnEvents.push({ type: e.type, entries: e.entries as unknown[] | undefined });
      },
    });
    const r = await tool.execute({ title: "t", instructions: "do" }, ctx());
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.output).entries).toBeUndefined();
    const activity = spawnEvents.find((e) => e.type === "activity");
    expect(activity?.entries).toHaveLength(1);
    const done = spawnEvents.find((e) => e.type === "done");
    expect(done?.entries).toHaveLength(2);
  });

  it("loads agent profile instructions and default tools when agentName is provided", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lvis-agents-"));
    try {
      writeFileSync(
        join(agentDir, "reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews code\ntools: [web_search]\n---\nYou are a reviewer.",
        "utf-8",
      );
      const store = new AgentProfileStore({ userDir: agentDir });
      let captured: { instructions: string; sourceTools?: string[] } | null = null;
      const tool = createAgentSpawnTool({
        getRunner: () => ({
          spawn: async (input) => {
            captured = {
              instructions: input.instructions,
              sourceTools: input.sourceTools,
            };
            return {
              summary: "reviewed",
              toolCallCount: 0,
              turnCount: 1,
              childSessionId: "child-1",
              entries: [],
              ok: true,
            };
          },
        }) as never,
        getAgentProfile: (name) => store.load(name),
        emit: () => undefined,
      });
      const r = await tool.execute(
        { agentName: "reviewer", instructions: "check this diff" },
        ctx(),
      );
      expect(r.isError).toBe(false);
      expect(captured?.instructions).toContain("<lvis-agent-profile");
      expect(captured?.instructions).toContain("You are a reviewer.");
      expect(captured?.instructions).toContain("check this diff");
      expect(captured?.sourceTools).toEqual(["web_search"]);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
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

describe("agent_status and agent_interrupt tools", () => {
  it("agent_status lists tracked runs or returns one run by id", async () => {
    const fakeRun = {
      spawnId: "spawn-1",
      childSessionId: "child-1",
      title: "Lookup",
      status: "running" as const,
      startedAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:01.000Z",
      toolCallCount: 1,
      turnCount: 0,
      entries: [],
    };
    const tool = createAgentStatusTool({
      getRunner: () => ({
        listRunStatuses: (originSessionId: string) => originSessionId === "session-x" ? [fakeRun] : [],
        getRunStatus: (id: string, originSessionId: string) =>
          id === "spawn-1" && originSessionId === "session-x" ? fakeRun : null,
      }) as never,
    });

    const listed = JSON.parse((await tool.execute({}, ctx())).output);
    expect(listed.runs).toEqual([fakeRun]);

    const one = JSON.parse((await tool.execute({ id: "spawn-1" }, ctx())).output);
    expect(one.run).toEqual(fakeRun);
  });

  it("agent_status requires and scopes to the current session id", async () => {
    const fakeRun = {
      spawnId: "spawn-1",
      childSessionId: "child-1",
      title: "Lookup",
      status: "running" as const,
      startedAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:01.000Z",
      toolCallCount: 1,
      turnCount: 0,
      entries: [],
    };
    const listSpy = vi.fn((originSessionId: string) => originSessionId === "session-a" ? [fakeRun] : []);
    const getSpy = vi.fn((id: string, originSessionId: string) =>
      id === "spawn-1" && originSessionId === "session-a" ? fakeRun : null);
    const tool = createAgentStatusTool({
      getRunner: () => ({
        listRunStatuses: listSpy,
        getRunStatus: getSpy,
      }) as never,
    });

    const missingSession = await tool.execute(
      {},
      { cwd: process.cwd(), extraAllowedDirectories: [], metadata: {} },
    );
    expect(missingSession.isError).toBe(true);
    expect(JSON.parse(missingSession.output).error).toContain("session id");

    const listed = JSON.parse((await tool.execute({}, ctx("session-a"))).output);
    expect(listed.runs).toEqual([fakeRun]);
    expect(listSpy).toHaveBeenCalledWith("session-a");

    const denied = await tool.execute({ id: "spawn-1" }, ctx("session-b"));
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.output).error).toContain("not found");
    expect(getSpy).toHaveBeenCalledWith("spawn-1", "session-b");
  });

  it("agent_interrupt delegates to the runner", async () => {
    const interruptSpy = vi.fn((id: string, originSessionId: string) => ({
      ok: true,
      message: `interrupt requested for ${id} in ${originSessionId}`,
    }));
    const tool = createAgentInterruptTool({
      getRunner: () => ({
        interruptRun: interruptSpy,
      }) as never,
    });

    const result = await tool.execute({ id: "spawn-1", reason: "not needed" }, ctx());
    expect(result.isError).toBe(false);
    expect(interruptSpy).toHaveBeenCalledWith("spawn-1", "session-x");
    expect(JSON.parse(result.output).ok).toBe(true);
  });

  it("agent_interrupt requires the current session id before delegating", async () => {
    const interruptSpy = vi.fn();
    const tool = createAgentInterruptTool({
      getRunner: () => ({
        interruptRun: interruptSpy,
      }) as never,
    });

    const result = await tool.execute(
      { id: "spawn-1" },
      { cwd: process.cwd(), extraAllowedDirectories: [], metadata: {} },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toContain("session id");
    expect(interruptSpy).not.toHaveBeenCalled();
  });
});

describe("skill_list and agent_list tools", () => {
  it("lists directory skills without loading their body into the prompt", async () => {
    const skillDir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      mkdirSync(join(skillDir, "deploy"), { recursive: true });
      writeFileSync(
        join(skillDir, "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy workflow\n---\nsecret body",
        "utf-8",
      );
      const tool = createSkillListTool(new SkillStore({ userDir: skillDir }));
      const r = await tool.execute({}, ctx());
      const parsed = JSON.parse(r.output);
      expect(parsed.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "deploy", description: "Deploy workflow" }),
        ]),
      );
      expect(parsed.skills[0]).not.toHaveProperty("triggers");
      expect(r.output).not.toContain("secret body");
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("lists agent profiles without exposing body text", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lvis-agents-"));
    try {
      writeFileSync(
        join(agentDir, "explorer.md"),
        "---\nname: explorer\ndescription: Map repo\ntools: [agent_list]\n---\nsecret profile body",
        "utf-8",
      );
      const tool = createAgentListTool(new AgentProfileStore({ userDir: agentDir }));
      const r = await tool.execute({}, ctx());
      const parsed = JSON.parse(r.output);
      expect(parsed.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "explorer", description: "Map repo" }),
        ]),
      );
      expect(r.output).not.toContain("secret profile body");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("tool_search meta tool", () => {
  it("fails closed if executor reaches the loop-intercepted fallback", async () => {
    const registry = new ToolRegistry();
    registerToolSearchMetaTool(registry);
    const tool = registry.findByName(TOOL_SEARCH_TOOL_NAME);
    expect(tool).toBeDefined();

    const result = await tool!.execute({ query: "meeting" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("interception");
  });
});

describe("request_plugin meta tool", () => {
  it("fails closed if executor reaches the loop-intercepted fallback", async () => {
    const registry = new ToolRegistry();
    registerRequestPluginMetaTool(registry);
    const tool = registry.findByName("request_plugin");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ pluginId: "local-indexer" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("interception");
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

  it("loads packaged report-writing skill from seed source and emits badge", async () => {
    // Post-first-boot, the seed copies report-writing into ~/.lvis/skills/.
    // Pointing userDir at resources/skills/ simulates that on-disk state.
    const store = new SkillStore({ userDir: BUILTIN_SKILLS_DIR });
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
    // The overlay carries the skill body for the current user turn's follow-up
    // rounds; ConversationLoop clears it at the turn boundary.
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
