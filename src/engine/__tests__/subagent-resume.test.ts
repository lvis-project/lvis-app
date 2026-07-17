/**
 * SubAgentRunner.resume — same-instance re-hydration continuation (PR-C).
 *
 * Security invariant under test: a resume RE-HYDRATES a frozen sub-agent, it
 * NEVER RE-AUTHORIZES. Every assertion here pins one facet of that:
 *
 *   1. full-history restore — the resumed child's continuation turn sees the
 *      original spawn's history (tool-pair valid, no loss).
 *   2. scoped tools identical — the resumed child's LLM schema exposes exactly
 *      meta.sourceTools (the frozen allowlist), nothing more.
 *   3. scope cannot widen — a tool the PARENT registry gained AFTER the spawn
 *      is NOT exposed to the resumed child (meta.sourceTools is the only source).
 *   4. depth stays 1 — the continuation turn runs at spawnDepth 1.
 *   5. no agent_spawn from resumed — the blocklist strip + spawnDepth defense
 *      hold on resume (agent_spawn absent from the resumed child registry).
 *   6. resume-exhausted — resumeCount >= MAX_RESUMES refuses without a turn.
 *   7. cumulative ceiling — cumulativeRounds >= ceiling refuses without a turn.
 *   8. concurrent-resume lock — two simultaneous resumes of the same id → one
 *      runs, one is rejected fail-closed; the counter is saved exactly once.
 *   9. round-cap → resumeId surfaced (agent-spawn.test coverage; see below).
 *  10. namespace isolation — resume persists ONLY to ~/.lvis/subagent/.
 *  11. counter increment — resumeCount +1, cumulativeRounds += turnCount, and
 *      the full-overwrite spread preserves sourceTools/profile*.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLoop } from "../conversation-loop.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { SubAgentRunner } from "../subagent-runner.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { createAgentSpawnTool } from "../../tools/agent-spawn.js";
import { createAgentSendTool } from "../../tools/agent-send.js";
import type { AgentSpawnEvent } from "../../shared/subagent-events.js";
import { A2AAgentMessageBus } from "../a2a-agent-message-bus.js";
import {
  A2AAgentMessageMailbox,
  type A2AAgentMailboxEntry,
} from "../a2a-agent-message-mailbox.js";
import { A2A_AGENT_MAX_TRACKED_TREES } from "../a2a-agent-message-envelope.js";

// ─── Test scaffolding ─────────────────────────────────

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  public turnsServed = 0;
  public observedToolNames: string[][] = [];
  public observedMessages: unknown[] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((params.tools ?? []).map((tool) => tool.name));
    this.observedMessages.push(structuredClone(params.messages));
    const idx = this.turnsServed++;
    yield* this.turns[idx] ?? this.turns[this.turns.length - 1] ?? [
      { type: "text_delta", text: "(out-of-script)" },
      { type: "message_complete", stopReason: "end_turn" },
    ];
  }
}

class AbortAwareBlockingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.markStarted();
    await new Promise<never>((_resolve, reject) => {
      const abort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (params.abortSignal?.aborted) {
        abort();
        return;
      }
      params.abortSignal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function buildLoopDeps(toolRegistry: ToolRegistry) {
  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });
  return {
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: () => undefined,
      setOriginSource: () => undefined,
      setActiveSessionId: () => undefined,
      setSummaryPreamble: () => undefined,
    },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => Promise.resolve(),
      listSessions: () => [],
    },
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0];
}

/** Register the fake provider onto every ConversationLoop the runner builds. */
function patchProvider(provider: LLMProvider) {
  const hasProviderSpy = vi
    .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
    .mockReturnValue(true);
  const refreshProviderSpy = vi
    .spyOn(ConversationLoop.prototype as unknown as { refreshProvider: () => void }, "refreshProvider")
    .mockImplementation(function (this: ConversationLoop) {
      (this as { provider: LLMProvider | null }).provider = provider;
    });
  return () => {
    hasProviderSpy.mockRestore();
    refreshProviderSpy.mockRestore();
  };
}

function noopTool(name: string) {
  return createDynamicTool({
    name,
    description: `${name} tool`,
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  });
}

const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

describe("SubAgentRunner.resume — re-hydration (PR-C)", () => {
  let tmpHome: string;
  let prevLvisHome: string | undefined;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "lvis-subagent-resume-"));
    process.env.LVIS_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeSubStore(): MemoryManager {
    const store = new MemoryManager({ lvisDir: openFeatureNamespace("subagent").dir });
    store.load();
    return store;
  }

  // A clean spawn (ends on round 1) so the child JSONL + meta are written and a
  // later resume has real history to re-hydrate.
  function cleanSpawnProvider(): ScriptedProvider {
    return new ScriptedProvider([
      [
        { type: "text_delta", text: "spawn answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
  }

  function waitingSpawnProvider(): ScriptedProvider {
    return new ScriptedProvider(
      Array.from({ length: 4 }, (_, index) => [
        { type: "text_delta", text: "partial-" + index },
        { type: "tool_call", id: "wait-" + index, name: "noop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ]),
    );
  }
  function makeAgentMailboxEntry(
    recipientChildSessionId: string,
    messageId = "message-idle-resume",
  ): A2AAgentMailboxEntry {
    return {
      id: "entry-" + messageId,
      createdAt: "2026-07-13T00:00:00.000Z",
      envelope: {
        version: 1,
        originSessionId: "parent-session-mailbox",
        senderChildSessionId: "sub-sender-mailbox",
        recipientChildSessionId,
        hopCount: 3,
        treeSequence: 1,
      },
      senderTitle: "sender-worker",
      recipientTitle: "recipient-worker",
      message: {
        messageId,
        contextId: "parent-session-mailbox",
        taskId: "sub-sender-mailbox",
        role: "ROLE_AGENT",
        parts: [{ text: "idle sibling guidance" }],
      },
      formattedText: "[Sub-Agent message from sender-worker]\nidle sibling guidance",
      approvalLabel: "[Sub-Agent: sender-worker]",
    };
  }

  it("persists and re-authorizes an explicit project cwd for fresh and resumed children", async () => {
    const explicitRoot = join(tmpHome, "agent-connector");
    const defaultRoot = join(tmpHome, "workspace");
    mkdirSync(explicitRoot, { recursive: true });
    mkdirSync(defaultRoot, { recursive: true });

    const observedCwds: string[] = [];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "cwd_probe",
      description: "capture the child cwd",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (_input, ctx) => {
        observedCwds.push(ctx.cwd);
        return { output: "cwd-ok", isError: false };
      },
    }));
    const authorizeProject = vi.fn((projectRoot: string) =>
      projectRoot === explicitRoot
        ? { projectRoot: explicitRoot, projectName: "agent-connector", isDefault: false }
        : null,
    );
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      getDefaultProject: () => ({
        projectRoot: defaultRoot,
        projectName: "workspace",
        isDefault: true,
      }),
      isDefaultProjectRoot: (projectRoot: string) => projectRoot === defaultRoot,
      authorizeProject,
    };
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(new ScriptedProvider([[
      { type: "tool_call", id: "spawn-cwd", name: "cwd_probe", input: {} },
      { type: "message_complete", stopReason: "tool_use" },
    ]]));
    let spawned: Awaited<ReturnType<SubAgentRunner["spawn"]>>;
    try {
      spawned = await runner.spawn({
        title: "project child",
        instructions: "inspect the project",
        sourceTools: ["cwd_probe"],
        maxRounds: 1,
        projectRoot: explicitRoot,
        projectName: "agent-connector",
      });
    } finally {
      restore();
    }

    expect(spawned.incomplete).toBe(true);
    expect(subStore.loadSessionMetadata(spawned.childSessionId)).toMatchObject({
      sessionKind: "subagent",
      projectRoot: explicitRoot,
      projectName: "agent-connector",
    });

    restore = patchProvider(new ScriptedProvider([
      [
        { type: "tool_call", id: "resume-cwd", name: "cwd_probe", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "resumed" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]));
    try {
      const resumed = await runner.resume(
        spawned.childSessionId,
        "continue",
        "project child",
      );
      expect(resumed.ok).toBe(true);
    } finally {
      restore();
    }

    expect(observedCwds).toEqual([explicitRoot, explicitRoot]);
    expect(authorizeProject).toHaveBeenCalledWith(explicitRoot, "agent-connector");
    expect(authorizeProject.mock.calls.filter(([root]) => root === explicitRoot)).toHaveLength(2);
  });

  it("binds an unscoped child to the default workspace without persisting it as explicit", async () => {
    const defaultRoot = join(tmpHome, "workspace");
    mkdirSync(defaultRoot, { recursive: true });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: {
        ...buildLoopDeps(toolRegistry),
        getDefaultProject: () => ({
          projectRoot: defaultRoot,
          projectName: "workspace",
          isDefault: true,
        }),
        isDefaultProjectRoot: (projectRoot: string) => projectRoot === defaultRoot,
        authorizeProject: (projectRoot: string) =>
          projectRoot === defaultRoot
            ? { projectRoot: defaultRoot, projectName: "workspace", isDefault: true }
            : null,
      },
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    const restore = patchProvider(cleanSpawnProvider());
    try {
      const spawned = await runner.spawn({
        title: "default child",
        instructions: "work in the default workspace",
        sourceTools: ["noop"],
      });
      const metadata = subStore.loadSessionMetadata(spawned.childSessionId);
      expect(metadata?.sessionKind).toBe("subagent");
      expect(metadata?.projectRoot).toBeUndefined();
      expect(metadata?.projectName).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("persists parent agent_spawn linkage and reloads the child transcript by explicit childSessionId", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    const restore = patchProvider(waitingSpawnProvider());
    try {
      const result = await runner.spawn({
        title: "linked child",
        instructions: "collect evidence",
        sourceTools: ["noop"],
        maxRounds: 2,
        originSessionId: "parent-session-1",
        toolUseId: "tool-use-1",
        spawnId: "spawn-1",
      });
      expect(result.ok).toBe(true);
      const meta = subStore.loadSessionMetadata(result.childSessionId);
      expect(meta).toMatchObject({
        sessionKind: "subagent",
        originSessionId: "parent-session-1",
        originToolUseId: "tool-use-1",
        spawnId: "spawn-1",
        subAgentTitle: "linked child",
      });
      const transcript = runner.getPersistedTranscript({
        originSessionId: "parent-session-1",
        childSessionId: result.childSessionId,
      });
      expect(transcript.ok).toBe(true);
      if (transcript.ok) {
        expect(transcript.childSessionId).toBe(result.childSessionId);
        expect(transcript.messages[0]?.role).toBe("user");
        expect(transcript.messages.some((message) => message.role === "assistant")).toBe(true);
        expect(transcript.messages.map((message) => message.content).join("\n")).toContain("partial-0");
      }
      expect(runner.listRunStatuses("parent-session-1").map((run) => run.childSessionId)).toEqual([
        result.childSessionId,
      ]);
      expect(runner.listRunStatuses("other-parent-session")).toEqual([]);
      expect(runner.getRunStatus("spawn-1", "parent-session-1")?.childSessionId).toBe(result.childSessionId);
      expect(runner.getRunStatus("spawn-1", "other-parent-session")).toBeNull();
      expect(runner.interruptRun("spawn-1", "other-parent-session")).toMatchObject({
        ok: false,
        message: "sub-agent run not found: spawn-1",
      });
      expect(runner.interruptRun("spawn-1", "parent-session-1")).toMatchObject({
        ok: false,
        message: "sub-agent run is not running: spawn-1",
      });

      const directTranscript = runner.getPersistedTranscript({
        originSessionId: "parent-session-1",
        childSessionId: result.childSessionId,
      });
      expect(directTranscript.ok).toBe(true);
      if (directTranscript.ok) {
        expect(directTranscript.childSessionId).toBe(result.childSessionId);
        expect(directTranscript.messages.map((message) => message.content).join("\n")).toContain("partial-0");
      }
      const crossOriginDirectTranscript = runner.getPersistedTranscript({
        originSessionId: "other-parent-session",
        childSessionId: result.childSessionId,
      });
      expect(crossOriginDirectTranscript).toEqual({
        ok: false,
        error: "sub-agent transcript not found",
      });
      await subStore.saveSessionMetadata(result.childSessionId, {
        sessionKind: "subagent",
        sourceTools: ["noop"],
        resumeCount: 0,
        cumulativeRounds: 1,
      });
      const missingLinkageTranscript = runner.getPersistedTranscript({
        originSessionId: "parent-session-1",
        childSessionId: result.childSessionId,
      });
      expect(missingLinkageTranscript).toEqual({
        ok: false,
        error: "sub-agent transcript not found",
      });
    } finally {
      restore();
    }
  });

  it("marks an accepted interrupt as interrupted before the child loop unwinds", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    const provider = new AbortAwareBlockingProvider();
    const restore = patchProvider(provider);
    try {
      const spawnPromise = runner.spawn({
        title: "interruptible child",
        instructions: "wait until interrupted",
        sourceTools: ["noop"],
        originSessionId: "parent-session-1",
        spawnId: "spawn-interrupt",
        maxRounds: 3,
      });
      await provider.started;

      const interrupted = runner.interruptRun("spawn-interrupt", "parent-session-1");

      expect(interrupted).toMatchObject({
        ok: true,
        run: { status: "interrupted", stopReason: "interrupted" },
      });
      expect(runner.getRunStatus("spawn-interrupt", "parent-session-1")).toMatchObject({
        status: "interrupted",
        stopReason: "interrupted",
      });

      const final = await spawnPromise;
      expect(final.stopReason).toBe("interrupted");
      expect(runner.getRunStatus("spawn-interrupt", "parent-session-1")).toMatchObject({
        status: "interrupted",
        stopReason: "interrupted",
      });
    } finally {
      restore();
    }
  });

  it.each([
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ] as const)("rejects persisted terminal state %s before linking or parent delivery", async (taskState) => {
    const originSessionId = "parent-terminal-resume";
    const deliverToParent = vi.fn();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
      messageBus: { deliverToParent } as never,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "terminal-resume",
      instructions: "wait",
      sourceTools: ["noop"],
      maxRounds: 2,
      originSessionId,
    });
    restore();
    const meta = subStore.loadSessionMetadata(spawn.childSessionId)!;
    await subStore.saveSessionMetadata(spawn.childSessionId, {
      ...meta,
      subAgentTaskState: taskState,
      subAgentSuspensionReason: undefined,
    });

    const guard = cleanSpawnProvider();
    restore = patchProvider(guard);
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });
    try {
      const handleResult = await tool.execute(
        {
          title: "terminal-resume",
          instructions: "must not run",
          resumeId: spawn.childSessionId,
          background: true,
        },
        {
          cwd: process.cwd(),
          extraAllowedDirectories: [],
          metadata: {
            sessionId: originSessionId,
            spawnDepth: 0,
            supportsA2AParentDelivery: true,
          },
        },
      );
      const handle = JSON.parse(handleResult.output) as Record<string, unknown>;
      expect(handleResult.isError).toBe(false);
      expect(handle.status).toBe("error");
      expect(handle.taskState).toBe("TASK_STATE_FAILED");
      expect(handle).not.toHaveProperty("childSessionId");

      await vi.waitFor(() =>
        expect(events.some((event) => event.type === "error")).toBe(true));
      expect(guard.turnsServed).toBe(0);
      expect(events.some((event) => event.type === "activity")).toBe(false);
      expect(events.find((event) => event.type === "error"))
        .not.toHaveProperty("childSessionId");
      expect(deliverToParent).not.toHaveBeenCalled();
      expect(subStore.loadSessionMetadata(spawn.childSessionId)).toMatchObject({
        subAgentTaskState: taskState,
        subAgentSuspensionReason: undefined,
      });
    } finally {
      restore();
    }
  });
  // ── 1) full-history restore ─────────────────────────
  it("re-hydrates the original spawn's full history into the continuation turn (tool-pair valid, no loss)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    // Spawn: round 1 calls noop (tool_use), round 2 ends. This lays down a
    // user + assistant(toolCall) + tool_result + assistant history to restore.
    const spawnProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "working" },
        { type: "tool_call", id: "tu-spawn", name: "noop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "spawn waiting" },
        { type: "tool_call", id: "tu-spawn-wait", name: "noop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
    ]);
    let restore = patchProvider(spawnProvider);
    const spawn = await runner.spawn({
      title: "hist",
      instructions: "do work",
      sourceTools: ["noop"],
      maxRounds: 5,
    });
    restore();
    expect(spawn.ok).toBe(true);
    const resumeId = spawn.childSessionId;

    // The persisted JSONL must carry the spawn's messages. Load them directly to
    // count history length the resume will restore.
    const persisted = subStore.loadSession(resumeId);
    expect(persisted).not.toBeNull();
    const spawnHistoryLen = persisted!.length;
    expect(spawnHistoryLen).toBeGreaterThan(1);

    // Resume: capture the history length the child loop sees when the
    // continuation turn starts. A fresh (non-hydrated) loop would see length 1
    // (just the continuation user message).
    const resumeProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "resumed answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    restore = patchProvider(resumeProvider);
    // Spy on ConversationLoop.runTurn to inspect the loop's history AT entry.
    let historyLenAtResumeEntry = -1;
    const origRunTurn = ConversationLoop.prototype.runTurn;
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(function (this: ConversationLoop, ...args: Parameters<typeof origRunTurn>) {
        historyLenAtResumeEntry = this.history.length;
        return origRunTurn.apply(this, args);
      });
    try {
      const resumed = await runner.resume(resumeId, "continue the work", "hist");
      expect(resumed.ok).toBe(true);
      expect(resumed.summary).toContain("resumed answer");
    } finally {
      runTurnSpy.mockRestore();
      restore();
    }
    // The resumed loop entered runTurn already carrying the spawn's restored
    // history (not a fresh length-1 loop) — proving re-hydration, not re-spawn.
    expect(historyLenAtResumeEntry).toBe(spawnHistoryLen);
  });

  // ── 2) scoped tools identical ───────────────────────
  it("scopes the resumed child to exactly meta.sourceTools (write tool absent)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("read_only"));
    toolRegistry.register({ ...noopTool("agent_send"), modelVisible: false });
    expect(toolRegistry.getToolSchemas().map((schema) => schema.name))
      .not.toContain("agent_send");
    toolRegistry.register(
      createDynamicTool({
        name: "bash",
        description: "shell",
        source: "builtin",
        category: "shell",
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "x", isError: false }),
      }),
    );
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "scoped",
      instructions: "do",
      sourceTools: ["read_only"], // bash intentionally excluded
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;
    expect(subStore.loadSessionMetadata(resumeId)?.sourceTools).toEqual(["read_only", "agent_send"]);

    const resumeProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    restore = patchProvider(resumeProvider);
    try {
      await runner.resume(resumeId, "continue", "scoped");
    } finally {
      restore();
    }
    // The resumed child's LLM schema saw exactly ["read_only"] — never "bash".
    expect(resumeProvider.observedToolNames[0]).toEqual(["read_only", "agent_send"]);
    expect(resumeProvider.observedToolNames[0]).not.toContain("bash");
  });

  // ── 3) scope cannot widen ───────────────────────────
  it("does NOT expose a tool the parent registry gained AFTER the spawn (scope frozen to meta.sourceTools)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("orig_tool"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "frozen",
      instructions: "do",
      sourceTools: ["orig_tool"],
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;

    // The parent registry GAINS a new tool after the spawn — a resume must NOT
    // pick it up (it consults meta.sourceTools, never the live parent registry).
    toolRegistry.register(noopTool("newly_added_tool"));

    const resumeProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    restore = patchProvider(resumeProvider);
    try {
      await runner.resume(resumeId, "continue", "frozen");
    } finally {
      restore();
    }
    expect(resumeProvider.observedToolNames[0]).toEqual(["orig_tool"]);
    expect(resumeProvider.observedToolNames[0]).not.toContain("newly_added_tool");
  });

  // ── 4) depth stays 1 + 5) no agent_spawn ────────────
  it("runs the continuation at spawnDepth 1 and never exposes agent_spawn to the resumed child", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    // agent_spawn IS in the parent registry AND in the frozen allowlist — the
    // blocklist strip must still remove it from the resumed child.
    toolRegistry.register(
      createDynamicTool({
        name: "agent_spawn",
        description: "spawn",
        source: "builtin",
        category: "meta",
        decisionOverride: "ask",
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "would-spawn", isError: false }),
      }),
    );
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "depth",
      instructions: "do",
      sourceTools: ["noop", "agent_spawn"], // agent_spawn must be stripped
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;
    // The persisted frozen scope already excludes agent_spawn (spawn stripped it).
    expect(subStore.loadSessionMetadata(resumeId)?.sourceTools).toEqual(["noop"]);

    let spawnDepthAtResume: unknown = "unset";
    const resumeProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    restore = patchProvider(resumeProvider);
    const origRunTurn = ConversationLoop.prototype.runTurn;
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(function (this: ConversationLoop, ...args: Parameters<typeof origRunTurn>) {
        // options is the 4th positional arg.
        const opts = args[3] as { spawnDepth?: number } | undefined;
        spawnDepthAtResume = opts?.spawnDepth;
        return origRunTurn.apply(this, args);
      });
    try {
      await runner.resume(resumeId, "continue", "depth");
    } finally {
      runTurnSpy.mockRestore();
      restore();
    }
    // Depth is hard-coded 1 on the continuation turn (recursion defense).
    expect(spawnDepthAtResume).toBe(1);
    // agent_spawn was never exposed to the resumed child's LLM schema.
    expect(resumeProvider.observedToolNames[0]).toEqual(["noop"]);
    expect(resumeProvider.observedToolNames[0]).not.toContain("agent_spawn");
  });

  // ── 6) resume-exhausted (resumeCount) ───────────────
  it("refuses a resume when resumeCount >= MAX_RESUMES (no turn run)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    const restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "exhaust",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;
    // Simulate legacy metadata that predates the split counters.
    const legacyMeta = { ...subStore.loadSessionMetadata(resumeId)! };
    delete legacyMeta.budgetResumeCount;
    delete legacyMeta.questionAnswerCount;
    await subStore.saveSessionMetadata(resumeId, { ...legacyMeta, resumeCount: 3 });

    // A provider that would fail the test if a turn actually ran.
    const guard = new ScriptedProvider([
      [{ type: "text_delta", text: "SHOULD NOT RUN" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    const restore2 = patchProvider(guard);
    try {
      const resumed = await runner.resume(resumeId, "continue", "exhaust");
      expect(resumed.ok).toBe(false);
      expect(resumed.resumeExhausted).toBe(true);
      expect(resumed.turnCount).toBe(0);
      // No turn ran → provider never streamed.
      expect(guard.turnsServed).toBe(0);
    } finally {
      restore2();
    }
  });


  it("fails closed when an INPUT_REQUIRED question was not staged by agent_send", async () => {
    const originSessionId = "parent-question";
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    const originalRunTurn = ConversationLoop.prototype.runTurn;
    const restore = patchProvider(cleanSpawnProvider());
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async (...args: Parameters<typeof originalRunTurn>) => {
        const callbacks = args[1] as
          | { onAssistantRound?: (round: { thought?: string; text: string }) => void }
          | undefined;
        callbacks?.onAssistantRound?.({ text: "waiting for the parent" });
        return {
          text: "I need the parent to choose.",
          toolCalls: [],
          route: "default",
          stopReason: "input-required",
          inputRequired: { reason: "question", prompt: "Which path?" },
        };
      });

    try {
      const result = await runner.spawn({
        title: "question-wait",
        instructions: "ask when blocked",
        sourceTools: ["noop"],
        originSessionId,
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("question delivery was not staged"),
      });
      expect(subStore.loadSessionMetadata(result.childSessionId)).toMatchObject({
        subAgentTaskState: "TASK_STATE_FAILED",
        subAgentSuspensionReason: undefined,
      });
    } finally {
      runTurnSpy.mockRestore();
      restore();
    }
  });

  it("resolves same-origin peers and atomically reserves one question wait per active sender", async () => {
    const toolRegistry = new ToolRegistry();
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    const originSessionId = "parent-peer";
    const senderChildSessionId = "sub-sender";
    const recipientChildSessionId = "sub-recipient";
    await subStore.saveSessionMetadata(senderChildSessionId, {
      sessionKind: "subagent",
      originSessionId,
      subAgentTitle: "sender",
      sourceTools: ["noop"],
      subAgentTaskState: "TASK_STATE_WORKING",
    });
    await subStore.saveSessionMetadata(recipientChildSessionId, {
      sessionKind: "subagent",
      originSessionId,
      subAgentTitle: "recipient",
      sourceTools: ["noop"],
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "budget",
    });

    const senderLoop = { hasActiveTurn: () => true } as unknown as ConversationLoop;
    const recipientLoop = { hasActiveTurn: () => true } as unknown as ConversationLoop;
    const activeChildren = (runner as unknown as {
      activeChildren: Map<string, {
        lease: symbol;
        childSessionId: string;
        originSessionId?: string;
        title: string;
        loop: ConversationLoop;
        background: boolean;
        questionWait?: { token: symbol; prompt: string };
      }>;
    }).activeChildren;
    activeChildren.set(senderChildSessionId, {
      lease: Symbol("sender"),
      childSessionId: senderChildSessionId,
      originSessionId,
      title: "sender",
      loop: senderLoop,
      background: true,
    });
    activeChildren.set(recipientChildSessionId, {
      lease: Symbol("recipient"),
      childSessionId: recipientChildSessionId,
      originSessionId,
      title: "recipient",
      loop: recipientLoop,
      background: false,
    });

    const route = await runner.resolveSubAgentPeer(
      senderChildSessionId,
      recipientChildSessionId,
    );
    expect(route).toMatchObject({
      ok: true,
      originSessionId,
      sender: { childSessionId: senderChildSessionId },
      recipient: {
        childSessionId: recipientChildSessionId,
        activeLoop: recipientLoop,
      },
    });
    await expect(runner.resolveSubAgentSender(senderChildSessionId)).resolves.toMatchObject({
      childSessionId: senderChildSessionId,
      originSessionId,
      background: true,
      taskState: "TASK_STATE_WORKING",
    });
    expect(runner.isSubAgentOriginActive(originSessionId)).toBe(true);
    expect(runner.isSubAgentOriginActive("other-origin")).toBe(false);


    const secret = "ghp_" + "b".repeat(24);
    const first = runner.reserveQuestionWait(
      senderChildSessionId,
      `Need input ${secret} ${"q".repeat(9_000)}`,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("question reservation unexpectedly failed");
    const reservedPrompt = activeChildren.get(senderChildSessionId)?.questionWait?.prompt;
    expect(reservedPrompt).toHaveLength(8_000);
    expect(reservedPrompt).not.toContain(secret);
    expect(first).not.toHaveProperty("prompt");
    expect(runner.reserveQuestionWait(senderChildSessionId, "second")).toEqual({
      ok: false,
      reason: "question-already-outstanding",
    });
    await expect(runner.cancelQuestionWait(senderChildSessionId, Symbol("wrong")))
      .resolves.toBe(false);
    await expect(runner.cancelQuestionWait(senderChildSessionId, first.token))
      .resolves.toBe(true);
    expect(runner.reserveQuestionWait(senderChildSessionId, "second").ok).toBe(true);

    await subStore.saveSessionMetadata(recipientChildSessionId, {
      ...subStore.loadSessionMetadata(recipientChildSessionId)!,
      originSessionId: "other-parent",
    });
    await expect(runner.resolveSubAgentPeer(
      senderChildSessionId,
      recipientChildSessionId,
    )).resolves.toEqual({ ok: false, reason: "cross-origin" });
    await expect(runner.resolveSubAgentPeer(
      senderChildSessionId,
      "sub-unknown",
    )).resolves.toEqual({ ok: false, reason: "unknown-recipient" });
  });
  it("preserves a persisted INPUT_REQUIRED tree across restart pressure and evicts terminal ownership", async () => {
    const activeOrigin = "parent-restart-active";
    const terminalOrigin = "parent-restart-terminal";
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const activeChild = "sub-persisted-input-required";
    const terminalChild = "sub-persisted-completed";

    await subStore.saveSession(activeChild, []);
    await subStore.saveSessionMetadata(activeChild, {
      sessionKind: "subagent",
      originSessionId: activeOrigin,
      subAgentTitle: "persisted active",
      sourceTools: ["noop"],
      resumeCount: 0,
      cumulativeRounds: 0,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "budget",
    });
    await subStore.saveSession(terminalChild, []);
    await subStore.saveSessionMetadata(terminalChild, {
      sessionKind: "subagent",
      originSessionId: terminalOrigin,
      subAgentTitle: "persisted terminal",
      sourceTools: ["noop"],
      resumeCount: 0,
      cumulativeRounds: 1,
      subAgentTaskState: "TASK_STATE_COMPLETED",
    });

    const restartedRunner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    expect(restartedRunner.isSubAgentOriginActive(activeOrigin)).toBe(true);
    expect(restartedRunner.isSubAgentOriginActive(terminalOrigin)).toBe(false);

    let stored: unknown;
    const mailbox = new A2AAgentMessageMailbox({
      dir: "memory",
      readJson: async (_name: string, fallback: unknown) =>
        structuredClone(stored === undefined ? fallback : stored),
      writeJson: async (_name: string, value: unknown) => {
        stored = structuredClone(value);
      },
      childDir: async (name: string) => name,
    } as never);
    const allocate = (originSessionId: string) => mailbox.allocateEnvelope({
      version: 1,
      originSessionId,
      senderChildSessionId: "sub-persisted-sender",
      recipientChildSessionId: "parent",
      hopCount: 1,
    }, (candidateOriginSessionId) =>
      restartedRunner.isSubAgentOriginActive(candidateOriginSessionId));

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await expect(allocate(activeOrigin)).resolves.toMatchObject({
        ok: true,
        envelope: { treeSequence: sequence },
      });
    }
    for (let index = 0; index < A2A_AGENT_MAX_TRACKED_TREES - 1; index += 1) {
      await allocate(index === 0 ? terminalOrigin : "parent-aged-" + index);
    }
    await expect(allocate("parent-after-restart")).resolves.toMatchObject({
      ok: true,
      envelope: { treeSequence: 1 },
    });
    await expect(allocate(activeOrigin)).resolves.toMatchObject({
      ok: true,
      envelope: { treeSequence: 6 },
    });
  });

  it("keeps a generic waiting child resumable on the fallback after workspace removal", async () => {
    const removedRoot = join(tmpHome, "resume-removed-root");
    const fallbackRoot = join(tmpHome, "resume-fallback-root");
    mkdirSync(removedRoot, { recursive: true });
    mkdirSync(fallbackRoot, { recursive: true });

    let rootRegistered = true;
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    let releaseMailbox!: () => void;
    const mailboxPending = new Promise<void>((resolve) => {
      releaseMailbox = resolve;
    });
    const peekRecipientMailbox = vi.fn(async () => {
      await mailboxPending;
      return [] as A2AAgentMailboxEntry[];
    });
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      getAdditionalDirectories: () => rootRegistered ? [removedRoot] : [],
      getDefaultProject: () => ({
        projectRoot: fallbackRoot,
        projectName: "fallback",
        isDefault: true,
      }),
      isDefaultProjectRoot: (projectRoot: string) => projectRoot === fallbackRoot,
      authorizeProject: (projectRoot: string, projectName?: string) =>
        rootRegistered && projectRoot === removedRoot
          ? { projectRoot: removedRoot, projectName: projectName ?? "removed", isDefault: false }
          : null,
    };
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: subStore,
      agentMessageBus: { peekRecipientMailbox } as never,
    });

    let restore = patchProvider(waitingSpawnProvider());
    let spawned: Awaited<ReturnType<SubAgentRunner["spawn"]>>;
    try {
      spawned = await runner.spawn({
        title: "resume removal race",
        instructions: "wait",
        sourceTools: ["noop"],
        maxRounds: 1,
        projectRoot: removedRoot,
        projectName: "removed",
      });
    } finally {
      restore();
    }
    expect(spawned.incomplete).toBe(true);

    const directoriesAtRuns: Array<readonly string[]> = [];
    const runTurnSpy = vi.spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async function (this: ConversationLoop) {
        directoriesAtRuns.push(this.getTurnAdditionalDirectories());
        const firstResume = directoriesAtRuns.length === 1;
        return {
          text: firstResume ? "still waiting" : "safe",
          toolCalls: [],
          route: "default",
          stopReason: firstResume ? "round-cap" as const : "end_turn" as const,
        };
      });
    restore = patchProvider(cleanSpawnProvider());
    let resumePromise: Promise<Awaited<ReturnType<SubAgentRunner["resume"]>>> | undefined;

    try {
      resumePromise = runner.resume(
        spawned.childSessionId,
        "continue",
        "resume removal race",
      );
      await vi.waitFor(() => expect(peekRecipientMailbox).toHaveBeenCalledTimes(1));
      expect(runTurnSpy).not.toHaveBeenCalled();

      await expect(runner.detachSessionsFromProject(removedRoot)).resolves.toBe(1);
      rootRegistered = false;
      expect(runner.revokeWorkspaceRoot(removedRoot, {
        globalScopeWasAuthorized: true,
      })).toMatchObject({
        activeChildrenVisited: 1,
      });

      releaseMailbox();
      const stillWaiting = await resumePromise;
      resumePromise = undefined;

      expect(stillWaiting).toMatchObject({
        ok: true,
        incomplete: true,
        stopReason: "round-cap",
        suspension: { reason: "budget" },
      });
      expect(runTurnSpy).toHaveBeenCalledTimes(1);
      expect(directoriesAtRuns[0]).toContain(fallbackRoot);
      expect(directoriesAtRuns[0]).not.toContain(removedRoot);
      expect(subStore.loadSessionMetadata(spawned.childSessionId)).toMatchObject({
        projectRoot: undefined,
        subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
        subAgentSuspensionReason: "budget",
      });

      const completed = await runner.resume(
        spawned.childSessionId,
        "continue again",
        "resume removal race",
      );
      expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
      expect(runTurnSpy).toHaveBeenCalledTimes(2);
      expect(directoriesAtRuns[1]).toContain(fallbackRoot);
      expect(directoriesAtRuns[1]).not.toContain(removedRoot);
      expect(subStore.loadSessionMetadata(spawned.childSessionId)).toMatchObject({
        projectRoot: undefined,
        subAgentTaskState: "TASK_STATE_COMPLETED",
      });
      expect((runner as unknown as { activeChildren: Map<string, unknown> }).activeChildren.size)
        .toBe(0);
    } finally {
      releaseMailbox();
      await resumePromise?.catch(() => undefined);
      runTurnSpy.mockRestore();
      restore();
    }
  });

  it("joins an idle sibling mailbox into resume and acknowledges only after end-turn commit", async () => {
    const originSessionId = "parent-session-mailbox";
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    let mailboxEntry: A2AAgentMailboxEntry | undefined;
    const peekRecipientMailbox = vi.fn(async (recipientChildSessionId: string) => {
      expect(subStore.loadSessionMetadata(recipientChildSessionId)?.subAgentTaskState)
        .toBe("TASK_STATE_INPUT_REQUIRED");
      return mailboxEntry ? [mailboxEntry] : [];
    });
    const acknowledgeRecipientMailbox = vi.fn(async (
      recipientChildSessionId: string,
      entries: readonly A2AAgentMailboxEntry[],
    ) => {
      expect(subStore.loadSessionMetadata(recipientChildSessionId)?.subAgentTaskState)
        .toBe("TASK_STATE_COMPLETED");
      return entries.length;
    });
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
      agentMessageBus: {
        peekRecipientMailbox,
        acknowledgeRecipientMailbox,
      } as never,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawned = await runner.spawn({
      title: "mailbox-recipient",
      instructions: "wait",
      sourceTools: ["noop"],
      maxRounds: 1,
      originSessionId,
    });
    restore();
    mailboxEntry = makeAgentMailboxEntry(spawned.childSessionId);
    const waitingMeta = subStore.loadSessionMetadata(spawned.childSessionId)!;
    await subStore.saveSessionMetadata(spawned.childSessionId, {
      ...waitingMeta,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "question",
      subAgentSuspensionPrompt: "Which option?",
    });

    let observedOptions: {
      initialGuidance?: string;
      approvalReasonPrefix?: string;
      a2aCausalContext?: unknown;
    } | undefined;
    restore = patchProvider(cleanSpawnProvider());
    const originalRunTurn = ConversationLoop.prototype.runTurn;
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(function (
        this: ConversationLoop,
        ...args: Parameters<typeof originalRunTurn>
      ) {
        observedOptions = args[3];
        expect(acknowledgeRecipientMailbox).not.toHaveBeenCalled();
        return originalRunTurn.apply(this, args);
      });
    let resumed;
    try {
      resumed = await runner.resume(
        spawned.childSessionId,
        "continue",
        "mailbox-recipient",
        undefined,
        originSessionId,
        undefined,
        true,
      );
    } finally {
      runTurnSpy.mockRestore();
      restore();
    }

    expect(resumed.stopReason).toBe("end_turn");
    expect(observedOptions).toMatchObject({
      initialGuidance: mailboxEntry.formattedText,
      approvalReasonPrefix: "[Sub-Agent: multiple sources]",
      a2aCausalContext: {
        kind: "a2a-causal-hop",
        version: 1,
        originSessionId,
        recipientChildSessionId: spawned.childSessionId,
        hopCount: 3,
      },
    });
    expect(peekRecipientMailbox).toHaveBeenCalledWith(spawned.childSessionId);
    expect(acknowledgeRecipientMailbox).toHaveBeenCalledWith(
      spawned.childSessionId,
      [mailboxEntry],
    );
    expect(JSON.stringify(subStore.loadSession(spawned.childSessionId)))
      .toContain("idle sibling guidance");
  });

  it.each(["round-cap", "interrupted", "stream-error"] as const)(
    "retains idle sibling mailbox delivery when resume stops with %s",
    async (stopReason) => {
      const originSessionId = "parent-session-mailbox";
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(noopTool("noop"));
      const subStore = makeSubStore();
      let mailboxEntry: A2AAgentMailboxEntry | undefined;
      const acknowledgeRecipientMailbox = vi.fn(async () => 1);
      const runner = new SubAgentRunner({
        parentDeps: buildLoopDeps(toolRegistry),
        toolRegistry,
        subAgentMemoryManager: subStore,
        agentMessageBus: {
          peekRecipientMailbox: vi.fn(async () =>
            mailboxEntry ? [mailboxEntry] : []),
          acknowledgeRecipientMailbox,
        } as never,
      });

      let restore = patchProvider(waitingSpawnProvider());
      const spawned = await runner.spawn({
        title: "mailbox-retain",
        instructions: "wait",
        sourceTools: ["noop"],
        maxRounds: 1,
        originSessionId,
      });
      restore();
      mailboxEntry = makeAgentMailboxEntry(
        spawned.childSessionId,
        "message-retain-" + stopReason,
      );

      restore = patchProvider(cleanSpawnProvider());
      const runTurnSpy = vi
        .spyOn(ConversationLoop.prototype, "runTurn")
        .mockResolvedValue({
          text: "resume stopped",
          toolCalls: [],
          stopReason,
        } as never);
      try {
        await runner.resume(
          spawned.childSessionId,
          "continue",
          "mailbox-retain",
          undefined,
          originSessionId,
          undefined,
          true,
        );
      } finally {
        runTurnSpy.mockRestore();
        restore();
      }

      expect(acknowledgeRecipientMailbox).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid question answers without consuming the wait, then accepts a valid answer", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "question-validation",
      instructions: "wait",
      sourceTools: ["noop"],
      maxRounds: 1,
    });
    restore();
    const meta = subStore.loadSessionMetadata(spawn.childSessionId)!;
    await subStore.saveSessionMetadata(spawn.childSessionId, {
      ...meta,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "question",
      subAgentSuspensionPrompt: "Which option?",
    });
    const waiting = subStore.loadSessionMetadata(spawn.childSessionId)!;

    const guard = new ScriptedProvider([[
      { type: "text_delta", text: "MUST-NOT-RUN" },
      { type: "message_complete", stopReason: "end_turn" },
    ]]);
    restore = patchProvider(guard);
    try {
      for (const invalidAnswer of ["", "x".repeat(9_000)]) {
        const rejected = await runner.resume(
          spawn.childSessionId,
          invalidAnswer,
          "question-validation",
        );
        expect(rejected).toMatchObject({
          ok: false,
          turnCount: 0,
          error: expect.stringContaining("question answer must be non-empty"),
        });
        expect(subStore.loadSessionMetadata(spawn.childSessionId)).toMatchObject({
          subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
          subAgentSuspensionReason: "question",
          subAgentSuspensionPrompt: "Which option?",
          budgetResumeCount: waiting.budgetResumeCount,
          questionAnswerCount: waiting.questionAnswerCount,
          cumulativeRounds: waiting.cumulativeRounds,
        });
      }
      expect(guard.turnsServed).toBe(0);
    } finally {
      restore();
    }

    const answerProvider = cleanSpawnProvider();
    restore = patchProvider(answerProvider);
    try {
      const accepted = await runner.resume(
        spawn.childSessionId,
        "Use option A",
        "question-validation",
      );
      expect(accepted.ok).toBe(true);
      expect(answerProvider.turnsServed).toBe(1);
    } finally {
      restore();
    }
  });

  it("masks a question answer and gates an always-allow tool under parent provenance", async () => {
    const originSessionId = "parent-question-answer-security";
    const execute = vi.fn(async () => ({ output: "ran", isError: false }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "question_probe",
      description: "question answer security probe",
      source: "builtin",
      category: "meta",
      modelVisible: true,
      decisionOverride: "always-allow-with-audit",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      approvalGate: { requestAndWait } as never,
    };
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(new ScriptedProvider([[
      { type: "tool_call", id: "spawn-probe", name: "question_probe", input: {} },
      { type: "message_complete", stopReason: "tool_use" },
    ]]));
    const spawn = await runner.spawn({
      title: "question-security",
      instructions: "wait",
      sourceTools: ["question_probe"],
      maxRounds: 1,
      originSessionId,
    });
    restore();
    const meta = subStore.loadSessionMetadata(spawn.childSessionId)!;
    await subStore.saveSessionMetadata(spawn.childSessionId, {
      ...meta,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "question",
      subAgentSuspensionPrompt: "Provide the value",
    });
    execute.mockClear();
    requestAndWait.mockClear();

    const resumeProvider = new ScriptedProvider([
      [
        { type: "tool_call", id: "resume-probe", name: "question_probe", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "denial observed" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const secret = "ghp_" + "a".repeat(24);
    restore = patchProvider(resumeProvider);
    try {
      const resumed = await runner.resume(
        spawn.childSessionId,
        "Use " + secret,
        "question-security",
        undefined,
        originSessionId,
      );
      expect(resumed.ok).toBe(true);
    } finally {
      restore();
    }

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining("[Sub-Agent: parent]"),
      trustOrigin: "agent-message",
    }));
    const providerInput = JSON.stringify(resumeProvider.observedMessages);
    expect(providerInput).toContain("[REDACTED:TOKEN]");
    expect(providerInput).not.toContain(secret);
    const transcript = runner.getPersistedTranscript({
      originSessionId,
      childSessionId: spawn.childSessionId,
    });
    expect(transcript.ok).toBe(true);
    if (transcript.ok) {
      const persisted = JSON.stringify(transcript.messages);
      expect(persisted).toContain("[REDACTED:TOKEN]");
      expect(persisted).not.toContain(secret);
    }
  });

  it("counts question answers separately from the budget-resume ceiling", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "question-counter",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();

    const meta = subStore.loadSessionMetadata(spawn.childSessionId)!;
    await subStore.saveSessionMetadata(spawn.childSessionId, {
      ...meta,
      budgetResumeCount: 3,
      questionAnswerCount: 4,
      resumeCount: 3,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "question",
    });

    const resumeProvider = cleanSpawnProvider();
    restore = patchProvider(resumeProvider);
    try {
      const onLinked = vi.fn();
      const resumed = await runner.resume(
        spawn.childSessionId,
        "the answer",
        "question-counter",
        { onLinked },
      );
      expect(resumed.ok).toBe(true);
      expect(resumeProvider.turnsServed).toBe(1);
      expect(onLinked).toHaveBeenCalledWith({ childSessionId: spawn.childSessionId });
    } finally {
      restore();
    }

    const updated = subStore.loadSessionMetadata(spawn.childSessionId)!;
    expect(updated.budgetResumeCount).toBe(3);
    expect(updated.resumeCount).toBe(3);
    expect(updated.questionAnswerCount).toBe(5);
    expect(updated.subAgentTaskState).toBe("TASK_STATE_COMPLETED");
    expect(updated.subAgentSuspensionReason).toBeUndefined();
  });

  it.each(["stream-error", "context-error"] as const)(
    "projects a non-throwing resume %s as FAILED and keeps counters unchanged",
    async (stopReason) => {
      const originSessionId = "parent-resume-stop-";
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(noopTool("noop"));
      const subStore = makeSubStore();
      const runner = new SubAgentRunner({
        parentDeps: buildLoopDeps(toolRegistry),
        toolRegistry,
        subAgentMemoryManager: subStore,
      });

      let restore = patchProvider(waitingSpawnProvider());
      const spawn = await runner.spawn({
        title: `resume-${stopReason}`,
        instructions: "wait",
        sourceTools: ["noop"],
        maxRounds: 2,
        originSessionId,
      });
      restore();
      const before = subStore.loadSessionMetadata(spawn.childSessionId)!;

      restore = patchProvider(cleanSpawnProvider());
      const runTurnSpy = vi.spyOn(ConversationLoop.prototype, "runTurn").mockResolvedValue({
        text: "",
        toolCalls: [],
        route: "default",
        stopReason,
      });
      try {
        const resumed = await runner.resume(
          spawn.childSessionId,
          "continue",
          `resume-${stopReason}`,
          undefined,
          originSessionId,
        );
        expect(resumed).toMatchObject({
          ok: false,
          error: `sub-agent resume stopped with ${stopReason}`,
          stopReason,
          turnCount: 0,
        });
        expect(runner.getRunStatus(spawn.childSessionId, originSessionId)).toMatchObject({
          status: "error",
          taskState: "TASK_STATE_FAILED",
          error: `sub-agent resume stopped with ${stopReason}`,
        });
        expect(subStore.loadSessionMetadata(spawn.childSessionId)).toMatchObject({
          budgetResumeCount: before.budgetResumeCount,
          questionAnswerCount: before.questionAnswerCount,
          cumulativeRounds: before.cumulativeRounds,
          subAgentTaskState: "TASK_STATE_FAILED",
          subAgentSuspensionReason: undefined,
        });
      } finally {
        runTurnSpy.mockRestore();
        restore();
      }
    },
  );
  // ── 7) cumulative ceiling ───────────────────────────
  it("refuses a resume when cumulativeRounds >= CUMULATIVE_ROUNDS_CEILING (no turn run)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    const restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "ceiling",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;
    const meta = subStore.loadSessionMetadata(resumeId)!;
    // 4 * MAX_TURNS_CAP(30) = 120. Set exactly at the ceiling.
    await subStore.saveSessionMetadata(resumeId, { ...meta, cumulativeRounds: 120 });

    const guard = new ScriptedProvider([
      [{ type: "text_delta", text: "SHOULD NOT RUN" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    const restore2 = patchProvider(guard);
    try {
      const resumed = await runner.resume(resumeId, "continue", "ceiling");
      expect(resumed.ok).toBe(false);
      expect(resumed.resumeExhausted).toBe(true);
      expect(guard.turnsServed).toBe(0);
    } finally {
      restore2();
    }
  });



  it("caps a near-ceiling resume to the remaining round and waiting adds no extra rounds", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "near-ceiling",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();

    const resumeId = spawn.childSessionId;
    const meta = subStore.loadSessionMetadata(resumeId)!;
    await subStore.saveSessionMetadata(resumeId, {
      ...meta,
      budgetResumeCount: 0,
      questionAnswerCount: 4,
      resumeCount: 0,
      cumulativeRounds: 119,
    });

    let observedMaxRounds: number | undefined;
    const originalRunTurn = ConversationLoop.prototype.runTurn;
    restore = patchProvider(cleanSpawnProvider());
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async (...args: Parameters<typeof originalRunTurn>) => {
        const callbacks = args[1] as
          | {
              onAssistantRound?: (round: { thought?: string; text: string }) => void;
            }
          | undefined;
        observedMaxRounds = (args[3] as { maxRounds?: number } | undefined)?.maxRounds;
        callbacks?.onAssistantRound?.({ text: "last allowed round" });
        return {
          text: "partial at cumulative ceiling",
          toolCalls: [],
          stopReason: "round-cap",
        } as Awaited<ReturnType<typeof originalRunTurn>>;
      });

    try {
      const waiting = await runner.resume(resumeId, "continue", "near-ceiling");
      expect(waiting.ok).toBe(true);
      expect(waiting.turnCount).toBe(1);
      expect(waiting.stopReason).toBe("round-cap");
      expect(waiting.suspension).toMatchObject({ reason: "budget", resumeId });
      expect(observedMaxRounds).toBe(1);

      const atCeiling = subStore.loadSessionMetadata(resumeId)!;
      expect(atCeiling.cumulativeRounds).toBe(120);
      expect(atCeiling.budgetResumeCount).toBe(1);
      expect(atCeiling.resumeCount).toBe(1);
      expect(atCeiling.questionAnswerCount).toBe(4);

      const refused = await runner.resume(resumeId, "continue again", "near-ceiling");
      expect(refused.ok).toBe(false);
      expect(refused.resumeExhausted).toBe(true);
      expect(refused.turnCount).toBe(0);
      expect(runTurnSpy).toHaveBeenCalledTimes(1);
      expect(subStore.loadSessionMetadata(resumeId)?.cumulativeRounds).toBe(120);
    } finally {
      runTurnSpy.mockRestore();
      restore();
    }
  });


  it("accounts assistant rounds completed before a spawn throws", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    const originalRunTurn = ConversationLoop.prototype.runTurn;
    const restore = patchProvider(cleanSpawnProvider());
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async (...args: Parameters<typeof originalRunTurn>) => {
        const callbacks = args[1] as
          | {
              onAssistantRound?: (round: { thought?: string; text: string }) => void;
            }
          | undefined;
        callbacks?.onAssistantRound?.({ text: "completed before failure" });
        throw new Error("partial spawn failure");
      });

    let spawn: Awaited<ReturnType<SubAgentRunner["spawn"]>>;
    try {
      spawn = await runner.spawn({
        title: "partial-spawn",
        instructions: "do",
        sourceTools: ["noop"],
        maxRounds: 3,
      });
    } finally {
      runTurnSpy.mockRestore();
      restore();
    }

    expect(spawn.ok).toBe(false);
    expect(spawn.turnCount).toBe(1);
    expect(spawn.error).toContain("partial spawn failure");
    expect(subStore.loadSessionMetadata(spawn.childSessionId)).toMatchObject({
      budgetResumeCount: 0,
      questionAnswerCount: 0,
      resumeCount: 0,
      cumulativeRounds: 1,
    });
  });


  it("accounts partial-failure rounds without merging budget and question counters", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "partial-resume",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();

    const resumeId = spawn.childSessionId;
    const meta = subStore.loadSessionMetadata(resumeId)!;
    await subStore.saveSessionMetadata(resumeId, {
      ...meta,
      budgetResumeCount: 1,
      questionAnswerCount: 7,
      resumeCount: 1,
      cumulativeRounds: 10,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "question",
    });

    const originalRunTurn = ConversationLoop.prototype.runTurn;
    restore = patchProvider(cleanSpawnProvider());
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async (...args: Parameters<typeof originalRunTurn>) => {
        const callbacks = args[1] as
          | {
              onAssistantRound?: (round: { thought?: string; text: string }) => void;
            }
          | undefined;
        callbacks?.onAssistantRound?.({ text: "completed before resume failure" });
        throw new Error("partial resume failure");
      });

    let resumed: Awaited<ReturnType<SubAgentRunner["resume"]>>;
    try {
      resumed = await runner.resume(resumeId, "answer the child", "partial-resume");
    } finally {
      runTurnSpy.mockRestore();
      restore();
    }

    expect(resumed.ok).toBe(false);
    expect(resumed.turnCount).toBe(1);
    expect(resumed.error).toContain("partial resume failure");
    expect(subStore.loadSessionMetadata(resumeId)).toMatchObject({
      budgetResumeCount: 1,
      questionAnswerCount: 7,
      resumeCount: 1,
      cumulativeRounds: 11,
    });
  });
  // ── 8) concurrent-resume lock ───────────────────────
  it("fail-closes a second concurrent resume of the same session (one runs, one rejected, one transition sequence)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "concurrent",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;
    expect(subStore.loadSessionMetadata(resumeId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "budget",
    });

    // A resume provider that yields control (await microtask) mid-turn so the
    // two resume() calls genuinely overlap before either resolves.
    const slowProvider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        await new Promise((r) => setTimeout(r, 20));
        yield { type: "text_delta", text: "resumed" } as StreamEvent;
        yield { type: "message_complete", stopReason: "end_turn" } as StreamEvent;
      },
    };
    restore = patchProvider(slowProvider);
    // Count how many times metadata is saved during the overlapping window.
    const saveSpy = vi.spyOn(subStore, "saveSessionMetadata");
    try {
      const [a, b] = await Promise.all([
        runner.resume(resumeId, "continue A", "concurrent"),
        runner.resume(resumeId, "continue B", "concurrent"),
      ]);
      const oks = [a, b].filter((r) => r.ok);
      const rejected = [a, b].filter((r) => !r.ok);
      expect(oks).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].error).toMatch(/already in flight/i);
      // Exactly one authorized resume persisted WORKING and one terminal state.
      expect(saveSpy).toHaveBeenCalledTimes(2);
      expect(saveSpy.mock.calls[0]?.[1]).toMatchObject({
        subAgentTaskState: "TASK_STATE_WORKING",
        subAgentSuspensionReason: undefined,
      });
      expect(saveSpy.mock.calls[1]?.[1]).toMatchObject({
        subAgentTaskState: "TASK_STATE_COMPLETED",
        subAgentSuspensionReason: undefined,
      });
    } finally {
      saveSpy.mockRestore();
      restore();
    }
    // The single successful resume bumped resumeCount to 1 (not 2 — the lost
    // update the lock prevents).
    expect(subStore.loadSessionMetadata(resumeId)).toMatchObject({
      resumeCount: 1,
      budgetResumeCount: 1,
      subAgentTaskState: "TASK_STATE_COMPLETED",
      subAgentSuspensionReason: undefined,
    });

    const terminalGuard = cleanSpawnProvider();
    const onLinked = vi.fn();
    restore = patchProvider(terminalGuard);
    try {
      const retry = await runner.resume(
        resumeId,
        "must not run",
        "concurrent",
        { onLinked },
      );
      expect(retry.ok).toBe(false);
      expect(retry.error).toMatch(/not in INPUT_REQUIRED|already terminal/i);
      expect(terminalGuard.turnsServed).toBe(0);
      expect(onLinked).not.toHaveBeenCalled();
      expect(subStore.loadSessionMetadata(resumeId)).toMatchObject({
        subAgentTaskState: "TASK_STATE_COMPLETED",
        subAgentSuspensionReason: undefined,
      });
    } finally {
      restore();
    }
  });

  it("composes concurrent background resume handles without aliasing or duplicate parent delivery", async () => {
    const originSessionId = "parent-background-resume";
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "winner-message",
    }));
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
      messageBus: { deliverToParent } as never,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "background-resume",
      instructions: "wait",
      sourceTools: ["noop"],
      maxRounds: 2,
      originSessionId,
    });
    restore();

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseWinner!: () => void;
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const blockingProvider: LLMProvider = {
      vendor: "openai",
      async *streamTurn(): AsyncIterable<StreamEvent> {
        markStarted();
        await winnerGate;
        yield { type: "text_delta", text: "winner completed" };
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    restore = patchProvider(blockingProvider);
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });
    const toolContext = {
      cwd: process.cwd(),
      extraAllowedDirectories: [],
      metadata: {
        sessionId: originSessionId,
        spawnDepth: 0,
        supportsA2AParentDelivery: true,
      },
    };

    try {
      const winnerResult = await tool.execute(
        {
          title: "background-resume",
          instructions: "continue",
          resumeId: spawn.childSessionId,
          background: true,
        },
        toolContext,
      );
      const winner = JSON.parse(winnerResult.output);
      await started;
      expect(winnerResult.isError).toBe(false);
      expect(winner).toMatchObject({
        childSessionId: spawn.childSessionId,
        status: "running",
        taskState: "TASK_STATE_WORKING",
      });

      const loserResult = await tool.execute(
        {
          title: "background-resume",
          instructions: "duplicate",
          resumeId: spawn.childSessionId,
          background: true,
        },
        toolContext,
      );
      const loser = JSON.parse(loserResult.output);
      expect(loserResult.isError).toBe(false);
      expect(loser.spawnId).not.toBe(winner.spawnId);
      expect(loser).toMatchObject({
        status: "error",
        taskState: "TASK_STATE_FAILED",
      });
      expect(loser).not.toHaveProperty("childSessionId");
      expect(runner.getRunStatus(loser.spawnId, originSessionId)).toMatchObject({
        status: "error",
        taskState: "TASK_STATE_FAILED",
        error: expect.stringContaining("already in flight"),
      });
      expect(runner.getRunStatus(spawn.childSessionId, originSessionId)).toMatchObject({
        spawnId: winner.spawnId,
        status: "running",
        taskState: "TASK_STATE_WORKING",
      });
      await vi.waitFor(() =>
        expect(events.some(
          (event) => event.spawnId === loser.spawnId && event.type === "error",
        )).toBe(true));
      expect(deliverToParent).not.toHaveBeenCalled();

      releaseWinner();
      await vi.waitFor(() => expect(deliverToParent).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(events.some(
          (event) => event.spawnId === winner.spawnId && event.type === "done",
        )).toBe(true));

      const winnerTerminal = events.filter(
        (event) => event.spawnId === winner.spawnId
          && (event.type === "done" || event.type === "error"),
      );
      const loserTerminal = events.filter(
        (event) => event.spawnId === loser.spawnId
          && (event.type === "done" || event.type === "error"),
      );
      expect(winnerTerminal).toHaveLength(1);
      expect(winnerTerminal[0]).toMatchObject({
        type: "done",
        childSessionId: spawn.childSessionId,
        taskState: "TASK_STATE_COMPLETED",
        status: "done",
      });
      expect(loserTerminal).toHaveLength(1);
      expect(loserTerminal[0]).toMatchObject({
        type: "error",
        taskState: "TASK_STATE_FAILED",
        status: "error",
      });
      expect(loserTerminal[0]).not.toHaveProperty("childSessionId");
      expect(deliverToParent.mock.calls[0]?.[0]).toMatchObject({
        parentSessionId: originSessionId,
        childSessionId: spawn.childSessionId,
      });
    } finally {
      releaseWinner();
      restore();
    }
  });
  it("terminalizes a resume as FAILED when its final metadata write rejects and denies retry", async () => {
    const originSessionId = "parent-resume-final-save";
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "resume-final-save",
      instructions: "wait",
      sourceTools: ["noop"],
      maxRounds: 2,
      originSessionId,
    });
    restore();

    const originalSave = subStore.saveSessionMetadata.bind(subStore);
    let saveCount = 0;
    const savedStates: unknown[] = [];
    const saveSpy = vi.spyOn(subStore, "saveSessionMetadata")
      .mockImplementation(async (sessionId, next) => {
        saveCount += 1;
        savedStates.push(next.subAgentTaskState);
        if (saveCount === 2) {
          throw new Error("final metadata write failed");
        }
        await originalSave(sessionId, next);
      });
    const provider = cleanSpawnProvider();
    restore = patchProvider(provider);
    try {
      const result = await runner.resume(
        spawn.childSessionId,
        "finish",
        "resume-final-save",
        undefined,
        originSessionId,
        "resume-final-save-attempt",
      );
      expect(result).toMatchObject({
        ok: false,
        error: "final metadata write failed",
      });
      expect(savedStates).toEqual([
        "TASK_STATE_WORKING",
        "TASK_STATE_COMPLETED",
        "TASK_STATE_FAILED",
      ]);
      expect(runner.getRunStatus(
        "resume-final-save-attempt",
        originSessionId,
      )).toMatchObject({
        status: "error",
        taskState: "TASK_STATE_FAILED",
        error: "final metadata write failed",
      });
      expect(subStore.loadSessionMetadata(spawn.childSessionId)).toMatchObject({
        subAgentTaskState: "TASK_STATE_FAILED",
        subAgentSuspensionReason: undefined,
      });

      const onLinked = vi.fn();
      const retry = await runner.resume(
        spawn.childSessionId,
        "retry",
        "resume-final-save",
        { onLinked },
        originSessionId,
        "resume-final-save-retry",
      );
      expect(retry.ok).toBe(false);
      expect(retry.error).toMatch(/not in INPUT_REQUIRED|already terminal/i);
      expect(onLinked).not.toHaveBeenCalled();
      expect(provider.turnsServed).toBe(1);
      expect(saveSpy).toHaveBeenCalledTimes(3);
    } finally {
      saveSpy.mockRestore();
      restore();
    }
  });

  it("rejects a late interrupt after the resume terminal commit point", async () => {
    const originSessionId = "parent-resume-commit";
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "resume-commit",
      instructions: "wait",
      sourceTools: ["noop"],
      maxRounds: 2,
      originSessionId,
    });
    restore();

    const originalSave = subStore.saveSessionMetadata.bind(subStore);
    let saveCount = 0;
    const savedStates: unknown[] = [];
    let signalFinalSave!: () => void;
    let releaseFinalSave!: () => void;
    const finalSaveEntered = new Promise<void>((resolve) => {
      signalFinalSave = resolve;
    });
    const finalSaveGate = new Promise<void>((resolve) => {
      releaseFinalSave = resolve;
    });
    const saveSpy = vi.spyOn(subStore, "saveSessionMetadata")
      .mockImplementation(async (sessionId, next) => {
        saveCount += 1;
        savedStates.push(next.subAgentTaskState);
        if (saveCount === 2) {
          signalFinalSave();
          await finalSaveGate;
        }
        await originalSave(sessionId, next);
      });
    const provider = cleanSpawnProvider();
    restore = patchProvider(provider);
    let pending: Promise<Awaited<ReturnType<SubAgentRunner["resume"]>>> | undefined;
    try {
      pending = runner.resume(
        spawn.childSessionId,
        "finish",
        "resume-commit",
        undefined,
        originSessionId,
        "resume-commit-cutoff",
      );
      await finalSaveEntered;

      expect(runner.interruptRun(
        "resume-commit-cutoff",
        originSessionId,
      )).toMatchObject({
        ok: false,
        run: {
          status: "running",
          taskState: "TASK_STATE_WORKING",
        },
      });
      expect(subStore.loadSessionMetadata(spawn.childSessionId)).toMatchObject({
        subAgentTaskState: "TASK_STATE_WORKING",
        subAgentSuspensionReason: undefined,
      });

      releaseFinalSave();
      const result = await pending;
      expect(result).toMatchObject({ ok: true, stopReason: "end_turn" });
      expect(savedStates).toEqual([
        "TASK_STATE_WORKING",
        "TASK_STATE_COMPLETED",
      ]);
      expect(runner.getRunStatus(
        "resume-commit-cutoff",
        originSessionId,
      )).toMatchObject({
        status: "done",
        taskState: "TASK_STATE_COMPLETED",
      });
      expect(subStore.loadSessionMetadata(spawn.childSessionId)).toMatchObject({
        subAgentTaskState: "TASK_STATE_COMPLETED",
        subAgentSuspensionReason: undefined,
      });
    } finally {
      releaseFinalSave();
      await pending?.catch(() => undefined);
      saveSpy.mockRestore();
      restore();
    }
  });
  // ── 10) namespace isolation ─────────────────────────
  it("persists the resumed continuation ONLY to ~/.lvis/subagent/ (never the main store)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const mainStore = new MemoryManager({ lvisDir: tmpHome });
    mainStore.load();
    const subStore = makeSubStore();
    const parentDeps = buildLoopDeps(toolRegistry);
    (parentDeps as { memoryManager: unknown }).memoryManager = mainStore;
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "iso",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;

    const resumeProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "resumed" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    restore = patchProvider(resumeProvider);
    try {
      const resumed = await runner.resume(resumeId, "continue", "iso");
      expect(resumed.ok).toBe(true);
    } finally {
      restore();
    }

    // The subagent JSONL exists under the isolated namespace…
    const subSessionsDir = join(tmpHome, "subagent", "sessions");
    expect(existsSync(join(subSessionsDir, `${resumeId}.jsonl`))).toBe(true);
    // …and nothing landed in the main sessions dir.
    const mainSessionsDir = join(tmpHome, "sessions");
    const mainFiles = existsSync(mainSessionsDir)
      ? readdirSync(mainSessionsDir).filter((f) => f.endsWith(".jsonl"))
      : [];
    expect(mainFiles).toEqual([]);
    expect(mainStore.listSessions()).toEqual([]);
  });

  // ── 11) counter increment (+1 / +turnCount, spread intact) ──
  it("increments resumeCount by 1 and cumulativeRounds by the turn's rounds, preserving the frozen scope (full-overwrite spread)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    // Spawn spends 2 rounds (round 1 tool_use, round 2 end) so cumulativeRounds
    // starts at 2 after the spawn's own accounting fix (Commit 2).
    const spawnProvider = new ScriptedProvider([
      [
        { type: "tool_call", id: "tu-1", name: "noop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "spawn waiting" },
        { type: "tool_call", id: "tu-counter-wait", name: "noop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
    ]);
    let restore = patchProvider(spawnProvider);
    const spawn = await runner.spawn({
      title: "counter",
      instructions: "do",
      sourceTools: ["noop"],
      profileModel: "high",
      profileMode: "execute",
      maxRounds: 5,
    });
    restore();
    const afterSpawn = subStore.loadSessionMetadata(spawn.childSessionId)!;
    // Spawn now records its OWN round count into cumulativeRounds (the accounting
    // fix in this commit; previously left at 0 → inaccurate resume-chain ceiling).
    expect(afterSpawn.cumulativeRounds).toBe(spawn.turnCount);
    expect(afterSpawn.resumeCount).toBe(0);
    expect(afterSpawn.budgetResumeCount).toBe(0);
    expect(afterSpawn.questionAnswerCount).toBe(0);
    const resumeId = spawn.childSessionId;
    // Question answers are a separate axis and must not consume MAX_RESUMES.
    await subStore.saveSessionMetadata(resumeId, {
      ...afterSpawn,
      questionAnswerCount: 7,
    });

    // Resume spends 1 round.
    const resumeProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "resumed" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    restore = patchProvider(resumeProvider);
    let resumed: Awaited<ReturnType<SubAgentRunner["resume"]>>;
    try {
      resumed = await runner.resume(resumeId, "continue", "counter");
    } finally {
      restore();
    }
    expect(resumed.ok).toBe(true);

    const afterResume = subStore.loadSessionMetadata(resumeId)!;
    // +1 resume, +turnCount rounds.
    expect(afterResume.resumeCount).toBe(1);
    expect(afterResume.budgetResumeCount).toBe(1);
    expect(afterResume.questionAnswerCount).toBe(7);
    expect(afterResume.cumulativeRounds).toBe(afterSpawn.cumulativeRounds! + resumed.turnCount);
    // Full-overwrite spread preserved the frozen scope + profile fields — a
    // dropped spread would corrupt the scope for the NEXT resume.
    expect(afterResume.sourceTools).toEqual(["noop"]);
    expect(afterResume.profileModel).toBe("high");
    expect(afterResume.profileMode).toBe("execute");
    expect(afterResume.sessionKind).toBe("subagent");
  });

  // ── fail-closed: non-subagent + missing metadata ────
  it("refuses to resume a session that is not a sub-agent", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    // Write a main-kind session metadata under a valid id.
    await subStore.saveSessionMetadata("not-a-subagent", {
      sessionKind: "main",
      sourceTools: ["noop"],
    });
    const resumed = await runner.resume("not-a-subagent", "continue", "x");
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/not a sub-agent/i);
  });

  it("refuses to resume an unknown session id (no metadata)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    const resumed = await runner.resume("sub-does-not-exist", "continue", "x");
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/no session metadata/i);
  });

  it("fail-closes on an invalid resumeId shape without throwing", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });
    const resumed = await runner.resume("bad::id//with:sep", "continue", "x");
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/invalid resumeId/i);
    // regex-invalid ids never even reach loadSessionMetadata (which would throw).
    expect(resumed.childSessionId).toBe("bad::id//with:sep");
    expect(resumed.childSessionId).not.toMatch(SESSION_ID_REGEX);
  });

  // ── MAJOR-3: cross-session origin binding ─────────────
  it("refuses cross-session resume: conversation B cannot resume conversation A's sub-agent (no history loaded, no turn run)", async () => {
    const { createHash } = await import("node:crypto");
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    // Spawn from conversation A (originSessionId = "session-A").
    const originA = "session-A";
    const tagA = createHash("sha256").update(originA).digest("hex").slice(0, 8);
    // We need a real spawn with origin. Manually write metadata under a
    // correctly-tagged id (mirrors what spawn writes when passed originSessionId).
    const { createDlpSafeUuid } = await import("../../shared/dlp-safe-id.js");
    const resumeId = createDlpSafeUuid(`sub-${tagA}`);
    await subStore.saveSessionMetadata(resumeId, {
      sessionKind: "subagent",
      sourceTools: ["noop"],
      originSessionId: originA,
      subAgentTitle: "owner",
      resumeCount: 0,
      cumulativeRounds: 0,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "budget",
    });
    // Also write a minimal session JSONL so loadSession would succeed IF we got
    // past the origin check (proves the guard fires before history is loaded).
    await subStore.saveSession(resumeId, []);

    // A provider that must NOT run (if it does, the test fails).
    const guardProvider = new ScriptedProvider([
      [{ type: "text_delta", text: "CROSS-SESSION-MUST-NOT-RUN" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    const restoreGuard = patchProvider(guardProvider);
    try {
      // Conversation B tries to resume with a DIFFERENT originSessionId.
      const originB = "session-B";
      const result = await runner.resume(resumeId, "hijack attempt", "attacker", undefined, originB);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not belong to this session/i);
      // No turn was run — the guard fires before the LLM is invoked.
      expect(guardProvider.turnsServed).toBe(0);
    } finally {
      restoreGuard();
    }

    // Positive: same origin (conversation A) CAN resume its own sub-agent.
    const resumeProvider = new ScriptedProvider([
      [{ type: "text_delta", text: "legitimate resume" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    const restoreResume = patchProvider(resumeProvider);
    try {
      const result = await runner.resume(resumeId, "legitimate continuation", "owner", undefined, originA);
      expect(result.ok).toBe(true);
      expect(result.summary).toContain("legitimate resume");
    } finally {
      restoreResume();
    }
  });

  it("rejects a tag-matching id when persisted origin metadata mismatches", async () => {
    const { createHash } = await import("node:crypto");
    const { createDlpSafeUuid } = await import("../../shared/dlp-safe-id.js");
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    const callerOrigin = "session-A";
    const tag = createHash("sha256").update(callerOrigin).digest("hex").slice(0, 8);
    const resumeId = createDlpSafeUuid("sub-" + tag);
    await subStore.saveSessionMetadata(resumeId, {
      sessionKind: "subagent",
      sourceTools: ["noop"],
      originSessionId: "session-collision-target",
      budgetResumeCount: 0,
      questionAnswerCount: 0,
      resumeCount: 0,
      cumulativeRounds: 0,
    });
    await subStore.saveSession(resumeId, []);

    const guardProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "MUST-NOT-RUN" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const restore = patchProvider(guardProvider);
    try {
      const result = await runner.resume(
        resumeId,
        "collision attempt",
        "attacker",
        undefined,
        callerOrigin,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/origin session metadata does not match caller/i);
      expect(guardProvider.turnsServed).toBe(0);
    } finally {
      restore();
    }
  });

  it("untagged sub-agent id (spawned without originSessionId) is resumable only by a no-origin caller", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    // Spawn without originSessionId → untagged id `sub-<uuid>`.
    let restore = patchProvider(waitingSpawnProvider());
    const spawn = await runner.spawn({
      title: "untagged",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();
    expect(spawn.ok).toBe(true);
    const resumeId = spawn.childSessionId;
    // Confirm the id is in untagged form (sub- followed immediately by UUID).
    expect(resumeId).toMatch(/^sub-[0-9a-f]{8}-[0-9a-f]{4}-/);

    // A caller with an explicit originSessionId is refused (the id has no tag
    // to match against, so idTag="" but expectedTag is non-empty).
    const guardProvider = new ScriptedProvider([
      [{ type: "text_delta", text: "SHOULD-NOT-RUN" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    restore = patchProvider(guardProvider);
    try {
      const result = await runner.resume(resumeId, "attempt", "caller", undefined, "some-session-id");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not belong to this session/i);
      expect(guardProvider.turnsServed).toBe(0);
    } finally {
      restore();
    }

    // No-origin caller (undefined) CAN resume it.
    const okProvider = new ScriptedProvider([
      [{ type: "text_delta", text: "ok" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    restore = patchProvider(okProvider);
    try {
      const result = await runner.resume(resumeId, "no-origin continue", "untagged-caller");
      expect(result.ok).toBe(true);
    } finally {
      restore();
    }
  });

  // ── MINOR: empty frozen scope → fail-closed ────────────
  it("refuses a resume when meta.sourceTools is empty (corruption/tamper signal), no turn run", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    // Write metadata with an explicitly empty sourceTools — simulates a
    // corrupted or tampered .meta.json (a real spawn always persists a non-empty
    // allowlist because the resolved scoped surface is non-empty after blocklist
    // strip; the only way to get [] is external tampering or corruption).
    const { createDlpSafeUuid } = await import("../../shared/dlp-safe-id.js");
    const resumeId = createDlpSafeUuid("sub");
    await subStore.saveSessionMetadata(resumeId, {
      sessionKind: "subagent",
      sourceTools: [], // deliberately empty — corruption signal
      subAgentTitle: "tamper-test",
      resumeCount: 0,
      cumulativeRounds: 0,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "budget",
    });

    const guardProvider = new ScriptedProvider([
      [{ type: "text_delta", text: "MUST-NOT-RUN" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    const restore = patchProvider(guardProvider);
    try {
      const result = await runner.resume(resumeId, "continue", "tamper-test");
      expect(result.ok).toBe(false);
      // Must refuse fail-closed, not warn and continue.
      expect(result.error).toMatch(/empty frozen tool scope/i);
      // No turn was run.
      expect(guardProvider.turnsServed).toBe(0);
      expect(result.resumeExhausted).toBeUndefined();
    } finally {
      restore();
    }
  });
  it("runs terminal mailbox cleanup after durable commit and skips INPUT_REQUIRED", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const cleanupTerminalRecipientMailbox = vi.fn(async (childSessionId: string) => {
      expect(subStore.loadSessionMetadata(childSessionId)).toMatchObject({
        subAgentTaskState: "TASK_STATE_COMPLETED",
      });
      return { ok: true as const, removed: 1, retained: 0 };
    });
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
      agentMessageBus: { cleanupTerminalRecipientMailbox } as never,
    });

    let restore = patchProvider(cleanSpawnProvider());
    try {
      const completed = await runner.spawn({
        title: "terminal cleanup",
        instructions: "finish",
      });
      expect(completed.ok).toBe(true);
      expect(cleanupTerminalRecipientMailbox)
        .toHaveBeenCalledWith(completed.childSessionId);
    } finally {
      restore();
    }

    cleanupTerminalRecipientMailbox.mockClear();
    restore = patchProvider(waitingSpawnProvider());
    try {
      const waiting = await runner.spawn({
        title: "waiting retain",
        instructions: "pause",
        sourceTools: ["noop"],
        maxRounds: 1,
      });
      expect(waiting).toMatchObject({
        ok: true,
        stopReason: "round-cap",
        suspension: { reason: "budget" },
      });
      expect(cleanupTerminalRecipientMailbox).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("commits a staged background question only after durable INPUT_REQUIRED metadata", async () => {
    const originSessionId = "parent-question-order";
    const toolRegistry = new ToolRegistry();
    let runner!: SubAgentRunner;
    toolRegistry.register(createAgentSendTool({ getRuntime: () => runner }));
    const subStore = makeSubStore();
    const namespace = openFeatureNamespace("subagent-messaging");
    const mailbox = new A2AAgentMessageMailbox(namespace);
    const audit = vi.fn();
    const parentDeliver = vi.fn(async (input: {
      childSessionId: string;
      message: { metadata?: unknown; messageId: string; parts: unknown[] };
    }) => {
      expect(subStore.loadSessionMetadata(input.childSessionId)).toMatchObject({
        subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
        subAgentSuspensionReason: "question",
        subAgentSuspensionPrompt: "Which option?",
      });
      expect(input.message).toMatchObject({
        parts: [{ text: "Which option?" }],
        metadata: {
          taskState: "TASK_STATE_INPUT_REQUIRED",
          suspension: {
            reason: "question",
            prompt: "Which option?",
            resumeId: input.childSessionId,
          },
        },
      });
      return {
        ok: true as const,
        disposition: "mailbox" as const,
        messageId: input.message.messageId,
      };
    });
    const bus = new A2AAgentMessageBus({
      parentBus: { deliverToParent: parentDeliver } as never,
      mailbox,
      auditLogger: { log: audit } as never,
      resolveSender: (childSessionId) => runner.resolveSubAgentSender(childSessionId),
      resolvePeer: (sender, recipient) => runner.resolveSubAgentPeer(sender, recipient),
      isOriginActive: (origin) => runner.isSubAgentOriginActive(origin),
    });
    runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
      agentMessageBus: bus,
    });
    const provider = new ScriptedProvider([[
      {
        type: "tool_call",
        id: "question-send",
        name: "agent_send",
        input: {
          to: "parent",
          parts: [{ text: "Which option?" }],
          waitForReply: true,
        },
      },
      { type: "message_complete", stopReason: "tool_use" },
    ]]);
    const restore = patchProvider(provider);
    try {
      const result = await runner.spawn({
        title: "question child",
        instructions: "ask parent",
        originSessionId,
        background: true,
      });
      expect(result).toMatchObject({
        ok: true,
        stopReason: "input-required",
        suspension: { reason: "question", prompt: "Which option?" },
      });
      expect(parentDeliver).toHaveBeenCalledTimes(1);
      expect(provider.turnsServed).toBe(1);
      const stored = await namespace.readJson<{
        trees: Array<{ originSessionId: string; messageCount: number }>;
      }>("agent-mailbox.json", { trees: [] });
      expect(stored.trees).toEqual([{ originSessionId, messageCount: 1 }]);
      expect(audit.mock.calls.filter(([entry]) =>
        String(entry.input).includes("delivered:parent"))).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("restores the durable waiting projection when commit and FAILED overwrite both fail", async () => {
    const originSessionId = "parent-question-fallback";
    const toolRegistry = new ToolRegistry();
    let runner!: SubAgentRunner;
    toolRegistry.register(createAgentSendTool({ getRuntime: () => runner }));
    const subStore = makeSubStore();
    const namespace = openFeatureNamespace("subagent-messaging");
    const mailbox = new A2AAgentMessageMailbox(namespace);
    const parentDeliver = vi.fn(async () => ({
      ok: false as const,
      reason: "storage-failed" as const,
    }));
    const bus = new A2AAgentMessageBus({
      parentBus: { deliverToParent: parentDeliver } as never,
      mailbox,
      auditLogger: { log: vi.fn() } as never,
      resolveSender: (childSessionId) => runner.resolveSubAgentSender(childSessionId),
      resolvePeer: (sender, recipient) => runner.resolveSubAgentPeer(sender, recipient),
      isOriginActive: (origin) => runner.isSubAgentOriginActive(origin),
    });
    runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
      agentMessageBus: bus,
    });
    const originalSave = subStore.saveSessionMetadata.bind(subStore);
    vi.spyOn(subStore, "saveSessionMetadata").mockImplementation(async (id, meta) => {
      if (meta.subAgentTaskState === "TASK_STATE_FAILED") {
        throw new Error("terminal overwrite failed");
      }
      await originalSave(id, meta);
    });
    const provider = new ScriptedProvider([[
      {
        type: "tool_call",
        id: "question-send-fallback",
        name: "agent_send",
        input: {
          to: "parent",
          parts: [{ text: "Which option?" }],
          waitForReply: true,
        },
      },
      { type: "message_complete", stopReason: "tool_use" },
    ]]);
    const restore = patchProvider(provider);
    try {
      const result = await runner.spawn({
        title: "question fallback",
        instructions: "ask parent",
        originSessionId,
        background: true,
      });
      expect(result).toMatchObject({
        ok: true,
        stopReason: "input-required",
        suspension: { reason: "question", prompt: "Which option?" },
      });
      expect(subStore.loadSessionMetadata(result.childSessionId)).toMatchObject({
        subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
        subAgentSuspensionReason: "question",
      });
      expect(runner.getRunStatus(result.childSessionId, originSessionId)).toMatchObject({
        taskState: "TASK_STATE_INPUT_REQUIRED",
        status: "waiting",
      });
      expect(parentDeliver).toHaveBeenCalledTimes(1);
      const stored = await namespace.readJson<{ trees?: unknown[] }>(
        "agent-mailbox.json",
        {},
      );
      expect(stored.trees ?? []).toEqual([]);
    } finally {
      restore();
    }
  });

});

// ─── 9) agent_spawn tool — resumeId surface + routing ─────────────────────────
describe("agent_spawn tool — resume surface + routing (PR-C)", () => {
  it("surfaces resumeId (= childSessionId) in an incomplete tool result so the parent LLM can continue", async () => {
    // A spawn that hit its round budget returns incomplete=true + a
    // childSessionId. The tool result must expose that id as `resumeId`.
    const tool = createAgentSpawnTool({
      getRunner: () =>
        ({
          spawn: async () => ({
            summary: "partial work",
            toolCallCount: 3,
            turnCount: 2,
            childSessionId: "sub-abcd1234-efgh",
            entries: [],
            ok: true,
            stopReason: "round-cap",
            incomplete: true,
          }),
        }) as never,
      emit: () => undefined,
    });
    const r = await tool.execute(
      { title: "budget", instructions: "big task" },
      { cwd: process.cwd(), metadata: { sessionId: "parent", spawnDepth: 0 }, extraAllowedDirectories: [] },
    );
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.incomplete).toBe(true);
    expect(parsed.resumeId).toBe("sub-abcd1234-efgh");
  });

  it("does NOT surface resumeId on a clean (complete) spawn result", async () => {
    const tool = createAgentSpawnTool({
      getRunner: () =>
        ({
          spawn: async () => ({
            summary: "done",
            toolCallCount: 1,
            turnCount: 1,
            childSessionId: "sub-xyz",
            entries: [],
            ok: true,
            stopReason: "end_turn",
          }),
        }) as never,
      emit: () => undefined,
    });
    const r = await tool.execute(
      { title: "clean", instructions: "small task" },
      { cwd: process.cwd(), metadata: { sessionId: "parent", spawnDepth: 0 }, extraAllowedDirectories: [] },
    );
    const parsed = JSON.parse(r.output);
    expect(parsed.incomplete).toBeUndefined();
    expect(parsed.resumeId).toBeUndefined();
  });

  it("routes to runner.resume (not spawn) when resumeId is present, forwarding instructions as the continuation", async () => {
    const resumeSpy = vi.fn(async () => ({
      summary: "resumed answer",
      toolCallCount: 0,
      turnCount: 1,
      childSessionId: "sub-resume-me",
      entries: [],
      ok: true,
      stopReason: "end_turn" as const,
    }));
    const spawnSpy = vi.fn();
    const tool = createAgentSpawnTool({
      getRunner: () => ({ resume: resumeSpy, spawn: spawnSpy }) as never,
      emit: () => undefined,
    });
    const r = await tool.execute(
      { instructions: "keep going", resumeId: "sub-resume-me" },
      { cwd: process.cwd(), metadata: { sessionId: "parent", spawnDepth: 0 }, extraAllowedDirectories: [] },
    );
    expect(r.isError).toBe(false);
    // resume() called with (resumeId, continuationInstructions, title, callbacks, originSessionId).
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy.mock.calls[0][0]).toBe("sub-resume-me");
    expect(resumeSpy.mock.calls[0][1]).toBe("keep going");
    // 5th arg is originSessionId (from ctx.metadata.sessionId = "parent").
    expect(resumeSpy.mock.calls[0][4]).toBe("parent");
    // spawn() never called on the resume path.
    expect(spawnSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(r.output);
    expect(parsed.summary).toBe("resumed answer");
  });

  it("surfaces a resume-exhausted refusal as a tool error", async () => {
    const tool = createAgentSpawnTool({
      getRunner: () =>
        ({
          resume: async () => ({
            summary: "sub-agent resume: exhausted (resumeCount=3 >= 3)",
            toolCallCount: 0,
            turnCount: 0,
            childSessionId: "sub-exhausted",
            entries: [],
            ok: false,
            error: "sub-agent resume: exhausted (resumeCount=3 >= 3)",
            resumeExhausted: true,
          }),
        }) as never,
      emit: () => undefined,
    });
    const r = await tool.execute(
      { instructions: "continue", resumeId: "sub-exhausted" },
      { cwd: process.cwd(), metadata: { sessionId: "parent", spawnDepth: 0 }, extraAllowedDirectories: [] },
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.output);
    expect(parsed.error).toMatch(/exhausted/i);
  });

  it("allows a resume from the parent loop but a sub-agent cannot resume (spawnDepth >= 1 refused)", async () => {
    const resumeSpy = vi.fn();
    const tool = createAgentSpawnTool({
      getRunner: () => ({ resume: resumeSpy, spawn: vi.fn() }) as never,
      emit: () => undefined,
    });
    // A resumed/sub-agent context (spawnDepth 1) must not be able to call
    // agent_spawn at all — the depth guard refuses before routing to resume.
    const r = await tool.execute(
      { instructions: "nested resume", resumeId: "sub-x" },
      { cwd: process.cwd(), metadata: { sessionId: "child", spawnDepth: 1 }, extraAllowedDirectories: [] },
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.output).error).toContain("cannot be invoked from a sub-agent");
    expect(resumeSpy).not.toHaveBeenCalled();
  });

});
