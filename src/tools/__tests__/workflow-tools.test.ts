/**
 * Unit tests for workflow system tools (S1+S2):
 * ask_user_question, routine_schedule, todo_session_write, agent_spawn,
 * agent_status, agent_interrupt, skill_load.
 *
 * Each test stubs the service dependency and exercises the tool's
 * `execute(rawInput, ctx)` contract directly — no Electron / IPC.
 */
import { describe, expect, it, vi } from "vitest";
import { withTz } from "../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { resolveEffectiveCeilingMs } from "../executor-ceiling.js";
import {
  TOOL_TIMEOUT_POLICY,
  resolveSubAgentCeilingMs,
} from "../../shared/tool-timeout-policy.js";
import { SUBAGENT_MAX_ROUNDS_DEFAULT } from "../../shared/subagent-policy.js";
import { createSkillLoadTool } from "../skill-load.js";
import { createSkillListTool } from "../skill-list.js";
import { createAgentListTool } from "../agent-list.js";
import { createAgentGuideTool } from "../agent-guide.js";
import { en as agentListEn } from "../../i18n/messages/generated/be_agentList.js";
import { en as agentSpawnEn } from "../../i18n/messages/generated/be_agentSpawn.js";
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

/**
 * A surface WITHOUT parent delivery — the only place spawns still run in the
 * foreground since the always-background directive. Blocking-result tests use
 * this deliberately: they exercise the fallback path, which remains the only
 * way to observe a spawn's terminal result synchronously.
 */
function foregroundCtx(sessionId = "session-x"): ToolExecutionContext {
  const base = ctx(sessionId);
  const { supportsA2AParentDelivery: _delivery, ...metadata } = base.metadata as {
    sessionId: string;
    supportsA2AParentDelivery: boolean;
  };
  return { ...base, metadata };
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

  it("rejects a question without non-empty choices", async () => {
    const tool = createAskUserQuestionTool({
      getGate: () => ({
        ask: () => Promise.resolve({ requestId: "r", answers: [] }),
      }) as never,
    });
    const r = await tool.execute(
      { questions: [{ question: "Pick" }] },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.output).toContain("at least one non-empty choice");
  });

  it("rejects duplicate, oversized, and overlong choices before opening the gate", async () => {
    const ask = vi.fn().mockResolvedValue({ requestId: "r", answers: [] });
    const tool = createAskUserQuestionTool({
      getGate: () => ({ ask }) as never,
    });

    for (const choices of [
      ["same", " same "],
      ["A", "B", "C", "D"],
      ["x".repeat(21)],
    ]) {
      const result = await tool.execute(
        { questions: [{ question: "Pick", choices }] },
        ctx(),
      );
      expect(result.isError).toBe(true);
    }
    expect(ask).not.toHaveBeenCalled();
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
      answers: [{ choice: "yes" }, { choice: "later" }],
      dismissed: false,
    });
    const tool = createAskUserQuestionTool({
      getGate: () => ({ ask }) as never,
    });
    const r = await tool.execute(
      {
        questions: [
          { question: "Continue?", choices: ["yes", "no"] },
          { question: "When?", choices: ["now", "later"] },
        ],
      },
      ctx(),
    );
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.answers).toEqual([{ choice: "yes" }, { choice: "later" }]);
    expect(parsed.dismissed).toBe(false);
    expect(ask).toHaveBeenCalledWith({
      questions: [
        { question: "Continue?", choices: ["yes", "no"] },
        { question: "When?", choices: ["now", "later"] },
      ],
      // The card is addressed to the conversation that asked, so the gate is
      // told which one that is.
      sessionId: "session-x",
      abortSignal: undefined,
    });
  });

  it("refuses when the invocation names no session, without opening a gate", async () => {
    // The executor omits `sessionId` rather than substituting a placeholder, so
    // this refusal is reachable: a card addressed to nothing would render
    // nowhere and hold the gate open until it timed out.
    const ask = vi.fn();
    const tool = createAskUserQuestionTool({ getGate: () => ({ ask }) as never });
    const unattributed: ToolExecutionContext = {
      cwd: process.cwd(),
      extraAllowedDirectories: [],
      metadata: { supportsA2AParentDelivery: true },
    };

    const r = await tool.execute(
      { questions: [{ question: "Continue?", choices: ["yes", "no"] }] },
      unattributed,
    );

    expect(r.isError).toBe(true);
    expect(JSON.parse(r.output).error).toContain("executing session");
    expect(ask).not.toHaveBeenCalled();
  });

  it("threads ctx.abortSignal into gate.ask", async () => {
    const ask = vi.fn().mockResolvedValue({ requestId: "r1", answers: [] });
    const tool = createAskUserQuestionTool({
      getGate: () => ({ ask }) as never,
    });
    const ac = new AbortController();
    await tool.execute(
      { questions: [{ question: "x", choices: ["yes", "no"] }] },
      { ...ctx(), abortSignal: ac.signal },
    );
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: ac.signal }),
    );
  });
});

describe("routine_schedule tool", () => {
  it("declares a literal-aware approval cache key for plugin scope", async () => {
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
      await cleanupTmpDir(tmp);
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
      await cleanupTmpDir(tmp);
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
      await cleanupTmpDir(tmp);
    }
  });

  it("accepts YYYY-MM-DD as 09:00 on the host's own calendar", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-rt-"));
    try {
      await withTz("Asia/Seoul", async () => {
        const store = new RoutinesStore(join(tmp, "routines.json"));
        const tool = createRoutineScheduleTool(store);
        const r = await tool.execute(
          { execution: "notification-only", schedule: { at: "2030-01-01" }, notificationTitle: "newyear" },
          ctx(),
        );
        expect(r.isError).toBe(false);
        const list = store.listActive();
        // 09:00 on the 1st in Seoul is 2030-01-01T00:00Z.
        expect(list[0].schedule?.at).toBe("2030-01-01T00:00:00.000Z");
      });
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("moves that 09:00 with the host, rather than pinning it to one zone", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-rt-"));
    try {
      await withTz("UTC", async () => {
        const store = new RoutinesStore(join(tmp, "routines.json"));
        const tool = createRoutineScheduleTool(store);
        const r = await tool.execute(
          { execution: "notification-only", schedule: { at: "2030-01-01" }, notificationTitle: "newyear" },
          ctx(),
        );
        expect(r.isError).toBe(false);
        // Same input, different host: 09:00 UTC, not 09:00 in Seoul.
        expect(store.listActive()[0].schedule?.at).toBe("2030-01-01T09:00:00.000Z");
      });
    } finally {
      await cleanupTmpDir(tmp);
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
      await cleanupTmpDir(tmp);
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

  it.each([undefined, false])("falls back to foreground when parent delivery is %s — the flag is ignored", async (capability) => {
    // Always-background directive: the model's `background` flag no longer
    // errors on an unsupported surface — it is simply ignored, and the spawn
    // runs foreground, the only coherent posture where results cannot be
    // delivered asynchronously.
    const runner = {
      spawn: vi.fn(async () => ({
        ok: true,
        summary: "done",
        toolCallCount: 0,
        turnCount: 1,
        entries: [],
        childSessionId: "sub-x",
      })),
    };
    const emit = vi.fn();
    const tool = createAgentSpawnTool({ getRunner: () => runner as never, emit });
    const metadata: Record<string, unknown> = { sessionId: "session-x" };
    if (capability !== undefined) metadata.supportsA2AParentDelivery = capability;

    const result = await tool.execute(
      { title: "background", instructions: "work", background: true },
      { cwd: process.cwd(), extraAllowedDirectories: [], metadata },
    );

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.output);
    expect(payload.background).toBeUndefined();
    expect(payload.summary).toBe("done");
    expect(runner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ background: false }),
      expect.anything(),
    );
  });

  it("always spawns in the background on a delivery-capable surface, flag or no flag", async () => {
    const runner = { spawn: vi.fn(async () => ({ ok: true })) };
    const tool = createAgentSpawnTool({ getRunner: () => runner as never, emit: vi.fn() });

    const result = await tool.execute(
      { title: "t", instructions: "work" },
      ctx(),
    );

    const payload = JSON.parse(result.output);
    expect(payload.background).toBe(true);
    expect(payload.spawnId).toBeDefined();
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
    let forwardedProjectRoot: string | undefined;
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async (input, callbacks) => {
          forwardedProjectRoot = input.projectRoot;
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
    const executionCwd = resolvePath("test-fixtures", "agent-connector");
    const r = await tool.execute(
      { title: "search", instructions: "find X" },
      { ...foregroundCtx(), cwd: executionCwd },
    );
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.summary).toBe("done-text");
    expect(parsed.toolCallCount).toBe(0);
    expect(parsed.childSessionId).toBe("child-1");
    expect(parsed.entries).toBeUndefined();
    expect(forwardedProjectRoot).toBe(executionCwd);
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
        spawn: async (_input: unknown, callbacks?: {
          onLinked?: (link: { childSessionId: string }) => void;
        }) => {
          // A real spawn links the child before it can produce any result, and
          // the terminal frame's join key is that AUTHORIZED link.
          callbacks?.onLinked?.({ childSessionId: "child-blocked" });
          return {
            summary: "prompt refused",
            toolCallCount: 0,
            turnCount: 0,
            childSessionId: "child-blocked",
            entries: [],
            ok: true,
            stopReason: "blocked" as const,
          };
        },
      }) as never,
      emit: (event) => events.push(event),
    });

    const result = await tool.execute(
      { title: "blocked", instructions: "attempt work" },
      foregroundCtx(),
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
      foregroundCtx(),
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
      foregroundCtx(),
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
            resumeRefusal: "exhausted" as const,
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
      foregroundCtx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      error: "resume exhausted",
      taskState: "TASK_STATE_REJECTED",
    });
    // An exhausted chain must say so and must NOT offer the dead resumeId back.
    const exhaustedPayload = JSON.parse(result.output);
    expect(exhaustedPayload.resumeRefusal).toBe("exhausted");
    expect(exhaustedPayload.resumeGuidance).toContain("재개할 수 없습니다");
    expect(exhaustedPayload.resumeId).toBeUndefined();
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
    const deadline = Date.now() + 4000;
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
    }), { terminalReport: true });
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

    const deadline = Date.now() + 4000;
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
    }), { terminalReport: true });
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

    const deadline = Date.now() + 4000;
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
        resumeRefusal: "exhausted" as const,
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

    const deadline = Date.now() + 4000;
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

    const deadline = Date.now() + 4000;
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
    }), { terminalReport: true });
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

    const deadline = Date.now() + 4000;
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
    }), { terminalReport: true });
  });

  it("a transient resume failure hands back the SAME resumeId with retry guidance", async () => {
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        resume: async () => {
          throw new Error("litellm.APIConnectionError: fetch failed (ECONNRESET)");
        },
      }) as never,
      emit: (e) => events.push(e),
    });

    const result = await tool.execute(
      { title: "t", instructions: "continue", resumeId: "child-transient" },
      foregroundCtx(),
    );

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.output);
    // The observed failure mode this pins: a bare error string gave the parent
    // nothing pointing back at the suspended child, so it respawned FRESH
    // agents and silently discarded the child's context.
    expect(payload.resumeId).toBe("child-transient");
    expect(payload.resumeGuidance).toContain("재개 가능");
    expect(payload.resumeRefusal).toBeUndefined();
    expect(payload.resumeDeterministicFailure).toBeUndefined();
  });

  it("a provider request rejection on resume drops the retry-same-id guidance", async () => {
    // The self-hosted grammar compiler validates the request and refuses it
    // BEFORE generating, so an identical resume (same frozen tool scope) is
    // refused identically forever — retry guidance there is an exit-less loop.
    // It is not a `resumeRefusal` either: the host authorized this resume and
    // the turn ran; a REMOTE system rejected the payload.
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        resume: async () => ({
          summary: "provider error",
          error: "litellm.BadRequestError: OpenAIException - Failed to initialize samplers: "
            + "failed to parse grammar. Received Model Group=muse-glimmer-30b",
          toolCallCount: 0,
          turnCount: 0,
          childSessionId: "child-grammar",
          entries: [],
          ok: false,
        }),
      }) as never,
      emit: () => {},
    });

    const result = await tool.execute(
      { title: "t", instructions: "continue", resumeId: "child-grammar" },
      foregroundCtx(),
    );

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.resumeRefusal).toBeUndefined();
    expect(payload.resumeDeterministicFailure).toBe(true);
    // The child stays addressable — it becomes resumable again once the model,
    // provider, or tool scope changes — but the text must not tell the model
    // that a bare retry clears it.
    expect(payload.resumeId).toBe("child-grammar");
    expect(payload.resumeGuidance).not.toContain("재개 가능합니다");
    expect(payload.resumeGuidance).toContain("provider 가 거부");
  });

  it("a THROWN provider request rejection is classified like a returned one", async () => {
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        resume: async () => {
          throw new Error(
            "litellm.BadRequestError: Failed to initialize samplers: failed to parse grammar",
          );
        },
      }) as never,
      emit: () => {},
    });

    const result = await tool.execute(
      { title: "t", instructions: "continue", resumeId: "child-grammar-throw" },
      foregroundCtx(),
    );

    const payload = JSON.parse(result.output);
    expect(payload.resumeDeterministicFailure).toBe(true);
    expect(payload.resumeGuidance).toContain("provider 가 거부");
  });

  it("a structural resume rejection never offers the resumeId back for retry", async () => {
    // `resumeRefusal: "invalid"` marks policy rejections (wrong task state, ownership,
    // tampered metadata) that fail identically forever. Emitting the retry
    // guidance there guided the model into an infinite retry against the
    // runner's INPUT_REQUIRED-only gate.
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        resume: async () => ({
          summary: "sub-agent resume: task is not in INPUT_REQUIRED",
          error: "sub-agent resume: task is not in INPUT_REQUIRED",
          toolCallCount: 0,
          turnCount: 0,
          childSessionId: "child-structural",
          entries: [],
          ok: false,
          resumeRefusal: "invalid" as const,
        }),
      }) as never,
      emit: () => {},
    });

    const result = await tool.execute(
      { title: "t", instructions: "continue", resumeId: "child-structural" },
      foregroundCtx(),
    );

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.resumeRefusal).toBe("invalid");
    expect(payload.resumeId).toBeUndefined();
    expect(payload.resumeGuidance).toContain("재시도하지 마세요");
  });

  it("sizes its executor wall clock from the configured round budget", () => {
    // The round budget has no maximum, so a fixed ceiling would let the clock
    // kill a long agent well before its rounds ran out — the setting would be
    // silently inert above the default. Small budgets still get the shipped
    // floor, so this can only ever widen a deadline.
    const toolFor = (roundBudget: number) =>
      createAgentSpawnTool({
        getRunner: () => ({ roundBudget: () => roundBudget }) as never,
        emit: () => {},
      });

    expect(resolveEffectiveCeilingMs(toolFor(SUBAGENT_MAX_ROUNDS_DEFAULT), {})).toBe(
      TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs,
    );
    expect(resolveEffectiveCeilingMs(toolFor(600), {})).toBe(
      resolveSubAgentCeilingMs(600),
    );
    expect(resolveEffectiveCeilingMs(toolFor(600), {})).toBeGreaterThan(
      TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs,
    );
    expect(resolveEffectiveCeilingMs(toolFor(2), {})).toBe(
      TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs,
    );
  });

  it("keeps the unvalidated resumeId off the terminal frame when the resume never linked", async () => {
    // The runner calls onLinked only AFTER origin + durable-state checks pass,
    // so a structurally refused resume has no authorized link — its
    // `result.childSessionId` is just the caller-supplied id that failed those
    // checks. The terminal frame must not hand the viewer that join key.
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        resume: async () => ({
          summary: "sub-agent resume: origin session metadata does not match caller",
          error: "sub-agent resume: origin session metadata does not match caller",
          toolCallCount: 0,
          turnCount: 0,
          childSessionId: "sub-deadbeef-cafebabe-other-session",
          entries: [],
          ok: false,
          resumeRefusal: "invalid" as const,
        }),
      }) as never,
      emit: (event) => events.push(event),
    });

    await tool.execute(
      {
        title: "t",
        instructions: "continue",
        resumeId: "sub-deadbeef-cafebabe-other-session",
      },
      foregroundCtx(),
    );

    const terminal = events.filter(
      (event) => event.type === "done" || event.type === "error",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      type: "error",
      taskState: "TASK_STATE_REJECTED",
    });
    expect(terminal[0]).not.toHaveProperty("childSessionId");
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
    const r = await tool.execute({ title: "t", instructions: "do" }, foregroundCtx());
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
      await cleanupTmpDir(agentDir);
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
    expect(listSpy).toHaveBeenCalledWith("session-a", { deliversReportToParent: true });

    const denied = await tool.execute({ id: "spawn-1" }, ctx("session-b"));
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.output).error).toContain("not found");
    expect(getSpy).toHaveBeenCalledWith("spawn-1", "session-b", { deliversReportToParent: true });
  });

  it("agent_status points at agent_list when only restored sub-agents remain", async () => {
    // Live runs are process-local; the children are not. After a restart the
    // run list is legitimately empty while the conversation's sub-agents are
    // still on disk — and an empty list was being read as "nothing running,
    // so the work is done".
    const tool = createAgentStatusTool({
      getRunner: () => ({
        listRunStatuses: () => [],
        listPersistedSpawnsForOrigin: (originSessionId: string) =>
          originSessionId === "session-x"
            ? [
                { childSessionId: "child-1", title: "Lookup", taskState: "INPUT_REQUIRED" },
                { childSessionId: "child-2", title: "Draft", taskState: "WORKING" },
              ]
            : [],
      }) as never,
    });

    const restored = JSON.parse((await tool.execute({}, ctx())).output);
    expect(restored.runs).toEqual([]);
    expect(restored.restoredSubAgentsHint).toContain("agent_list");
    expect(restored.restoredSubAgentsHint).toContain("2");
  });

  it("agent_status stays silent when there is nothing restored to point at", async () => {
    const tool = createAgentStatusTool({
      getRunner: () => ({
        listRunStatuses: () => [],
        listPersistedSpawnsForOrigin: () => [],
      }) as never,
    });

    const empty = JSON.parse((await tool.execute({}, ctx())).output);
    expect(empty.runs).toEqual([]);
    expect(empty.restoredSubAgentsHint).toBeUndefined();
  });

  it("says in both descriptions where restored sub-agents are listed", () => {
    // The hint only fires after a call that already returned an empty list.
    // A model that reads "active or recent runs" and stops there never makes
    // that call — so the same fact has to be in what it reads beforehand.
    // Tool names survive translation; the sentence around them does not, so
    // the wording is asserted on the English catalog and the pointing on the
    // rendered description.
    const status = createAgentStatusTool({ getRunner: () => undefined });
    expect(status.description).toContain("agent_list");
    expect(agentSpawnEn["be_agentSpawn.statusToolDescription"]).toContain(
      "restart",
    );

    const list = createAgentListTool({ store: { list: async () => [] } as never });
    expect(list.description).toContain("agent_status");
    expect(agentListEn["be_agentList.toolDescription"]).toContain("restart");
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
      await cleanupTmpDir(skillDir);
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
      const tool = createAgentListTool({ store: new AgentProfileStore({ userDir: agentDir }) });
      const r = await tool.execute({}, ctx());
      const parsed = JSON.parse(r.output);
      expect(parsed.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "explorer", description: "Map repo" }),
        ]),
      );
      expect(r.output).not.toContain("secret profile body");
    } finally {
      await cleanupTmpDir(agentDir);
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
      approvalGate: undefined as never,
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
      approvalGate: undefined as never,
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
      approvalGate: undefined as never,
      emit: () => undefined,
    });
    const r = await tool.execute({ skillName: "../../etc/passwd" }, ctx());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.output);
    expect(parsed.error).toContain("invalid skillName");
  });

  it("fails closed for plugin Skills when exact generation access is not wired", async () => {
    const store = new SkillStore({});
    const load = vi.spyOn(store, "load");
    const tool = createSkillLoadTool({
      store,
      overlay: new SkillOverlay(),
      approvals: stubApprovals,
      approvalGate: undefined as never,
      emit: () => undefined,
    });
    const result = await tool.execute(
      { skillName: "plugin:ep-api:attendance" },
      ctx("sess-plugin"),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toContain("generation access unavailable");
    expect(load).not.toHaveBeenCalled();
  });
});

describe("agent_guide tool", () => {
  it("delegates a directive to the runner under the caller's own session id", async () => {
    const queueSpy = vi.fn(async () => ({
      ok: true as const,
      disposition: "queued" as const,
      childSessionId: "child-1",
      messageId: "message-1",
    }));
    const tool = createAgentGuideTool({
      getRunner: () => ({ queueParentMessageToChild: queueSpy }) as never,
    });

    const result = await tool.execute(
      { childSessionId: "child-1", message: "change direction" },
      ctx(),
    );
    expect(result.isError).toBe(false);
    // The origin is the HOST-supplied session id, never anything the model wrote.
    expect(queueSpy).toHaveBeenCalledWith("session-x", "child-1", "change direction");
    expect(JSON.parse(result.output)).toMatchObject({
      childSessionId: "child-1",
      disposition: "queued",
    });
  });

  it("tells the parent how a stored directive will be delivered", async () => {
    const tool = createAgentGuideTool({
      getRunner: () => ({
        queueParentMessageToChild: async () => ({
          ok: true as const,
          disposition: "mailbox" as const,
          childSessionId: "child-1",
          messageId: "message-1",
        }),
      }) as never,
    });

    const parsed = JSON.parse(
      (await tool.execute({ childSessionId: "child-1", message: "stop" }, ctx())).output,
    );
    expect(parsed.disposition).toBe("mailbox");
    expect(parsed.guidance).toContain("agent_spawn(resumeId)");
  });

  it("refuses a sub-agent caller — a child has no children to direct", async () => {
    const queueSpy = vi.fn();
    const tool = createAgentGuideTool({
      getRunner: () => ({ queueParentMessageToChild: queueSpy }) as never,
    });

    const refused = await tool.execute(
      { childSessionId: "child-1", message: "change direction" },
      {
        cwd: process.cwd(),
        extraAllowedDirectories: [],
        metadata: { sessionId: "sub-1", spawnDepth: 1 },
      },
    );
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.output).error).toContain("cannot be invoked from a sub-agent");
    expect(queueSpy).not.toHaveBeenCalled();
  });

  it("requires a session id, a recipient, and a non-empty message", async () => {
    const queueSpy = vi.fn();
    const tool = createAgentGuideTool({
      getRunner: () => ({ queueParentMessageToChild: queueSpy }) as never,
    });

    const noSession = await tool.execute(
      { childSessionId: "child-1", message: "hi" },
      { cwd: process.cwd(), extraAllowedDirectories: [], metadata: {} },
    );
    expect(noSession.isError).toBe(true);
    expect(JSON.parse(noSession.output).error).toContain("session id");

    const noRecipient = await tool.execute({ childSessionId: "  ", message: "hi" }, ctx());
    expect(JSON.parse(noRecipient.output).error).toBe("unknown-recipient");

    const noMessage = await tool.execute({ childSessionId: "child-1", message: " " }, ctx());
    expect(JSON.parse(noMessage.output).error).toBe("invalid-message");
    expect(queueSpy).not.toHaveBeenCalled();
  });

  it("names non-resumability instead of leaving the parent to retry", async () => {
    const tool = createAgentGuideTool({
      getRunner: () => ({
        queueParentMessageToChild: async () => ({
          ok: false as const,
          reason: "child-not-resumable" as const,
        }),
      }) as never,
    });

    const refused = await tool.execute(
      { childSessionId: "child-1", message: "stop" },
      ctx(),
    );
    expect(refused.isError).toBe(true);
    const parsed = JSON.parse(refused.output);
    expect(parsed.error).toBe("child-not-resumable");
    expect(parsed.guidance).toContain("agent_list");
  });
});
