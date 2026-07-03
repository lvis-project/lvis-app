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
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
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

// ─── Test scaffolding ─────────────────────────────────

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  public turnsServed = 0;
  public observedToolNames: string[][] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((params.tools ?? []).map((tool) => tool.name));
    const idx = this.turnsServed++;
    yield* this.turns[idx] ?? this.turns[this.turns.length - 1] ?? [
      { type: "text_delta", text: "(out-of-script)" },
      { type: "message_complete", stopReason: "end_turn" },
    ];
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
        { type: "text_delta", text: "spawn done" },
        { type: "message_complete", stopReason: "end_turn" },
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

    let restore = patchProvider(cleanSpawnProvider());
    const spawn = await runner.spawn({
      title: "scoped",
      instructions: "do",
      sourceTools: ["read_only"], // bash intentionally excluded
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;
    expect(subStore.loadSessionMetadata(resumeId)?.sourceTools).toEqual(["read_only"]);

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
    expect(resumeProvider.observedToolNames[0]).toEqual(["read_only"]);
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

    let restore = patchProvider(cleanSpawnProvider());
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

    let restore = patchProvider(cleanSpawnProvider());
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

    const restore = patchProvider(cleanSpawnProvider());
    const spawn = await runner.spawn({
      title: "exhaust",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;
    // Force resumeCount to the ceiling directly in metadata (full overwrite).
    const meta = subStore.loadSessionMetadata(resumeId)!;
    await subStore.saveSessionMetadata(resumeId, { ...meta, resumeCount: 3 });

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

    const restore = patchProvider(cleanSpawnProvider());
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

  // ── 8) concurrent-resume lock ───────────────────────
  it("fail-closes a second concurrent resume of the same session (one runs, one rejected, one counter save)", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(noopTool("noop"));
    const subStore = makeSubStore();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: subStore,
    });

    let restore = patchProvider(cleanSpawnProvider());
    const spawn = await runner.spawn({
      title: "concurrent",
      instructions: "do",
      sourceTools: ["noop"],
      maxRounds: 2,
    });
    restore();
    const resumeId = spawn.childSessionId;

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
      // Exactly ONE resume ran its turn → exactly one counter save.
      expect(saveSpy).toHaveBeenCalledTimes(1);
    } finally {
      saveSpy.mockRestore();
      restore();
    }
    // The single successful resume bumped resumeCount to 1 (not 2 — the lost
    // update the lock prevents).
    expect(subStore.loadSessionMetadata(resumeId)?.resumeCount).toBe(1);
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

    let restore = patchProvider(cleanSpawnProvider());
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
        { type: "text_delta", text: "spawn done" },
        { type: "message_complete", stopReason: "end_turn" },
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
    // Spawn seeds cumulativeRounds at 0 (the spawn-side accounting fix lands in
    // the follow-up commit); the resume-side increment is what this test pins.
    expect(afterSpawn.cumulativeRounds).toBe(0);
    expect(afterSpawn.resumeCount).toBe(0);
    const resumeId = spawn.childSessionId;

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
    // resume() called with (resumeId, continuationInstructions, title, callbacks).
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy.mock.calls[0][0]).toBe("sub-resume-me");
    expect(resumeSpy.mock.calls[0][1]).toBe("keep going");
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
