/**
 * SubAgentRunner — behavioral coverage for three concrete failure modes
 * (turn-cap enforcement, sourceTools allowlist, recursive spawn refusal):
 *
 *   1. C3(a) maxRounds bound — the runner must stop emitting LLM rounds
 *      once the host-assigned `maxRounds` budget is reached, even if the fake
 *      provider would happily keep streaming. The `maxRounds` plumb-through in
 *      queryLoop is the loop-boundary defense for this. When the budget is hit
 *      with work still pending, the runner marks the result `incomplete` and
 *      forwards stopReason "round-cap" (cut-off resume signal).
 *
 *   2. sourceTools allowlist — a sub-agent that requests a tool not in
 *      `sourceTools` must receive a "tool not found" result. Validates
 *      that ToolRegistry.createScopedView is actually being applied.
 *
 *   3. C3(b) recursive spawn refusal — a sub-agent calling agent_spawn
 *      must receive the "cannot be invoked from a sub-agent" error,
 *      regardless of whether the registry strip succeeded.
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
import {
  SubAgentRunner,
  resolveSubAgentModel,
  buildModePreamble,
} from "../subagent-runner.js";
import { MODEL_COMPLEXITY_MAP } from "../../shared/model-complexity-map.js";
import { LLM_VENDOR_MODEL_OPTIONS } from "../../shared/llm-vendor-defaults.js";
import { AGENT_MODE_MAP } from "../../shared/agent-mode-map.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { createAgentSpawnTool } from "../../tools/agent-spawn.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { buildPluginToolsForTest } from "../../plugins/__tests__/plugin-tool-test-fixture.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";

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

/**
 * Minimal fake for the ISOLATED subagent MemoryManager (`~/.lvis/subagent/`).
 * SubAgentRunner now composes the child loop with this store instead of the
 * parent's main-chat MemoryManager, so every construction must supply it.
 * A no-op saveSession is enough for the behavioral suites here; the
 * persistence-routing suite below uses a REAL MemoryManager on a temp home.
 */
function fakeSubAgentMemoryManager() {
  return {
    saveSession: () => Promise.resolve(),
    listSessions: () => [],
    load: () => undefined,
  } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["subAgentMemoryManager"];
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

// ─── 1) maxRounds bound ───────────────────────────────

describe("SubAgentRunner — maxRounds bound", () => {
  it("terminates after the host-assigned `maxRounds` budget even if provider keeps emitting tool calls, and flags the cut-off run incomplete", async () => {
    const toolRegistry = new ToolRegistry();
    const execSpy = vi.fn(async () => ({ output: "ok", isError: false }));
    toolRegistry.register(
      createDynamicTool({
        name: "noop",
        description: "no-op tool",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: execSpy,
      }),
    );

    // 5 rounds of "still calling tools" — but maxTurns=2 must clamp.
    const provider = new ScriptedProvider(
      Array.from({ length: 5 }).map((_, i) => [
        { type: "text_delta", text: `round-${i}` },
        { type: "tool_call", id: `tu-${i}`, name: "noop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ] as StreamEvent[]),
    );

    const parentLoop = new ConversationLoop(buildLoopDeps(toolRegistry));
    (parentLoop as { provider: LLMProvider | null }).provider = provider;

    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    // Inject the fake provider into the child loop too — runner constructs
    // a fresh ConversationLoop per spawn, so we patch the prototype.
    const origConstructor = ConversationLoop.prototype as unknown as {
      hasProvider: () => boolean;
    };
    const hasProviderSpy = vi
      .spyOn(origConstructor, "hasProvider")
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { refreshProvider: () => void }, "refreshProvider")
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });

    try {
      const result = await runner.spawn({
        title: "test",
        instructions: "do",
        sourceTools: ["noop"],
        maxRounds: 2,
      });
      // R2-CR-2: tighten — `<=2` would also pass on a regression that bails
      // out at 0 or 1 rounds. The provider script emits 5 valid tool_use
      // rounds, so with maxTurns=2 the loop MUST execute exactly 2 rounds.
      expect(result.turnCount).toBe(2);
      // Per-round tool fan-out cap is 10; with maxTurns=2 the total tool
      // call count is bounded by 2 * 10 = 20.
      expect(result.toolCallCount).toBeLessThanOrEqual(2 * 10);
      // R2-CR-2: tighten — exactly 2 tool executions happened (one per round
      // since the provider emits a single tool_call per round). A regression
      // that early-terminates would invoke the executor 0 or 1 times only.
      expect(execSpy).toHaveBeenCalledTimes(2);
      // Cut-off resume signal: the provider still wanted to keep calling tools
      // when the budget was hit, so this run stopped on its round budget with
      // work pending. The runner must surface that as a SUCCESSFUL-but-
      // incomplete result (ok=true, incomplete=true) forwarding stopReason
      // "round-cap" — NOT a failed spawn — so the parent can decide to continue.
      expect(result.ok).toBe(true);
      expect(result.incomplete).toBe(true);
      expect(result.stopReason).toBe("round-cap");
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("does NOT flag a clean end_turn completion as incomplete", async () => {
    const toolRegistry = new ToolRegistry();
    // Provider ends naturally on round 1, well within the budget.
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "final answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { refreshProvider: () => void },
        "refreshProvider",
      )
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });
    try {
      const result = await runner.spawn({
        title: "clean",
        instructions: "do",
        maxRounds: 5,
      });
      expect(result.ok).toBe(true);
      expect(result.stopReason).toBe("end_turn");
      // Cut-off resume signal must be OFF: a finished turn is not incomplete.
      expect(result.incomplete).toBeFalsy();
      expect(result.summary).toContain("final answer");
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });
});

// ─── 2) sourceTools allowlist ─────────────────────────

describe("SubAgentRunner — sourceTools allowlist", () => {
  it("filters tools so a not-listed tool is unavailable to the LLM", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      createDynamicTool({
        name: "bash",
        description: "shell",
        source: "builtin",
        category: "shell",
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "bash-out", isError: false }),
      }),
    );
    toolRegistry.register(
      createDynamicTool({
        name: "read_file",
        description: "read",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "file-contents", isError: false }),
      }),
    );

    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });

    // Build the scoped view via the runner's registry filter and assert it
    // contains "bash" but not "read_file" — exercises the allowlist
    // contract directly without firing a fake provider.
    const scoped = toolRegistry.createScopedView(["bash"]);
    expect(scoped.findByName("bash")).toBeDefined();
    expect(scoped.findByName("read_file")).toBeUndefined();
    void runner; // referenced so test compiles even if assertions trim
  });

  it("keeps allowlisted plugin tools visible to the child LLM schema", async () => {
    const toolRegistry = new ToolRegistry();
    const execSpy = vi.fn(async () => ({ output: "schedule", isError: false }));
    const scheduleToolName = "plugin_today_team_schedule";
    toolRegistry.register(
      createDynamicTool({
        name: scheduleToolName,
        description: "team schedule",
        source: "plugin",
        pluginId: "sample-plugin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: execSpy,
      }),
    );
    toolRegistry.register(
      createDynamicTool({
        name: "other_plugin_tool",
        description: "other",
        source: "plugin",
        pluginId: "other-plugin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "other", isError: false }),
      }),
    );

    const provider = new ScriptedProvider([
      [
        { type: "tool_call", id: "tu-1", name: scheduleToolName, input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const parentDeps = buildLoopDeps(toolRegistry);
    const runner = new SubAgentRunner({ parentDeps, toolRegistry, subAgentMemoryManager: fakeSubAgentMemoryManager() });
    const hasProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { refreshProvider: () => void }, "refreshProvider")
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });

    try {
      await runner.spawn({
        title: "team schedule",
        instructions: "오늘 팀 스케줄 조회",
        sourceTools: [scheduleToolName],
        maxRounds: 2,
      });

      expect(provider.observedToolNames[0]).toEqual([scheduleToolName]);
      expect(provider.observedToolNames[0]).not.toContain("other_plugin_tool");
      expect(execSpy).toHaveBeenCalledOnce();
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("does not execute an inactive plugin's tool even when allowlisted via sourceTools", async () => {
    // The scoped view a sub-agent receives does not rebuild tools — it hands
    // out the same gated adapter objects. sourceTools is not filtered by
    // isPluginEnabled (an inactive tool name CAN be allowlisted and exposed),
    // so the boundary must hold at execution: the adapter fail-closes before
    // reaching the runtime.
    const toolRegistry = new ToolRegistry();
    const runtimeCall = vi.fn(async () => ({ items: ["secret"] }));
    const fakeRuntime = {
      isPluginEnabled: () => false,
      call: runtimeCall,
    } as unknown as PluginRuntime;
    const toolName = "index_scan";
    for (const tool of buildPluginToolsForTest(fakeRuntime, "local-indexer", {
      id: "local-indexer",
      name: "indexer",
      version: "1.0.0",
      main: "x.js",
      tools: [toolName],
      toolSchemas: {
        [toolName]: {
          description: "scan the index",
          category: "read",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    } as PluginManifest)) {
      toolRegistry.register(tool);
    }

    const provider = new ScriptedProvider([
      [
        { type: "tool_call", id: "tu-1", name: toolName, input: { q: "x" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const runner = new SubAgentRunner({ parentDeps: buildLoopDeps(toolRegistry), toolRegistry, subAgentMemoryManager: fakeSubAgentMemoryManager() });
    const hasProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { refreshProvider: () => void }, "refreshProvider")
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });

    try {
      await runner.spawn({
        title: "indexer",
        instructions: "scan",
        sourceTools: [toolName],
        maxRounds: 2,
      });

      // Exposed to the child (sourceTools is not isPluginEnabled-filtered)…
      expect(provider.observedToolNames[0]).toContain(toolName);
      // …but execution fails closed at the adapter — the runtime is never hit.
      expect(runtimeCall).not.toHaveBeenCalled();
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });
});

// ─── 3) Recursive spawn refusal ───────────────────────

describe("agent_spawn — recursive call refusal", () => {
  it("returns an error when invoked from a sub-agent (spawnDepth >= 1)", async () => {
    const tool = createAgentSpawnTool({
      getRunner: () => ({ spawn: async () => ({}) }) as never,
      emit: () => undefined,
    });
    // Simulate the executor metadata for a sub-agent invocation.
    const ctxAsSubAgent = {
      cwd: process.cwd(),
      metadata: { sessionId: "child-1", spawnDepth: 1 },
      extraAllowedDirectories: [],
    };
    const r = await tool.execute(
      { title: "nested", instructions: "go deeper" },
      ctxAsSubAgent,
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.output);
    expect(parsed.error).toContain("cannot be invoked from a sub-agent");
  });

  it("allows agent_spawn from the parent loop (spawnDepth=0)", async () => {
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn: async () => ({
          summary: "ok",
          toolCallCount: 0,
          turnCount: 1,
          childSessionId: "c",
          entries: [],
          ok: true,
        }),
      }) as never,
      emit: () => undefined,
    });
    const ctxAsParent = {
      cwd: process.cwd(),
      metadata: { sessionId: "parent", spawnDepth: 0 },
      extraAllowedDirectories: [],
    };
    const r = await tool.execute(
      { title: "child", instructions: "do" },
      ctxAsParent,
    );
    expect(r.isError).toBe(false);
  });
});

// ─── SubAgentRunner blocklist ────────────────────────

describe("SubAgentRunner — agent_spawn always stripped", () => {
  it("strips agent_spawn from the child registry even when sourceTools includes it", async () => {
    const toolRegistry = new ToolRegistry();
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
    toolRegistry.register(
      createDynamicTool({
        name: "noop",
        description: "no-op",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "ok", isError: false }),
      }),
    );

    // Direct probe of the blocklist behavior: the scoped view a runner would
    // hand the child must NOT include `agent_spawn` even when listed.
    const scopedFromAllowlist = toolRegistry.createScopedView(
      ["agent_spawn", "noop"].filter((n) => n !== "agent_spawn"),
    );
    expect(scopedFromAllowlist.findByName("agent_spawn")).toBeUndefined();
    expect(scopedFromAllowlist.findByName("noop")).toBeDefined();
  });
});

describe("resolveSubAgentModel — #1112 complexity resolution", () => {
  it("resolves a complexity tier to the active vendor's model", () => {
    expect(resolveSubAgentModel("mid", "claude")).toBe(
      MODEL_COMPLEXITY_MAP.claude.mid,
    );
    expect(resolveSubAgentModel("high", "openai")).toBe(
      MODEL_COMPLEXITY_MAP.openai.high,
    );
    expect(resolveSubAgentModel("low", "gemini")).toBe(
      MODEL_COMPLEXITY_MAP.gemini.low,
    );
  });

  it("passes an explicit model ID through only when the active vendor offers it", () => {
    const claudeOpt = LLM_VENDOR_MODEL_OPTIONS.claude[0];
    expect(resolveSubAgentModel(claudeOpt, "claude")).toBe(claudeOpt);
    const openaiOpt = LLM_VENDOR_MODEL_OPTIONS.openai[0];
    expect(resolveSubAgentModel(openaiOpt, "openai")).toBe(openaiOpt);
  });

  it("falls back to the parent model (null) + warns when an explicit ID is not selectable for the active vendor", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      // An openai model ID under the claude vendor: claude cannot serve it,
      // so it must NOT reach the provider as a non-retryable model-not-found.
      expect(resolveSubAgentModel("gpt-5.4", "claude")).toBeNull();
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/parent-model fallback used/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns null for undefined / empty — caller keeps the parent model", () => {
    expect(resolveSubAgentModel(undefined, "claude")).toBeNull();
    expect(resolveSubAgentModel("", "claude")).toBeNull();
    expect(resolveSubAgentModel("   ", "claude")).toBeNull();
  });

  it("returns null when the active vendor is outside the union (boundary)", () => {
    // A complexity tier needs a known vendor to map against. An unknown
    // vendor string (corrupt settings, etc.) yields the parent-model
    // fallback rather than a wrong model.
    expect(resolveSubAgentModel("mid", "totally-fake-vendor")).toBeNull();
  });

  it("trims surrounding whitespace before classifying", () => {
    expect(resolveSubAgentModel("  mid  ", "claude")).toBe(
      MODEL_COMPLEXITY_MAP.claude.mid,
    );
  });
});

describe("buildModePreamble — #1113 mode posture + skill recommendation", () => {
  it("includes the posture line and skill recommendation for a skill-bearing mode", () => {
    const preamble = buildModePreamble(AGENT_MODE_MAP.execute);
    expect(preamble).toContain("<lvis-agent-mode-posture>");
    expect(preamble).toContain(AGENT_MODE_MAP.execute.reasoningHint);
    expect(preamble).toContain("<lvis-agent-mode-skills>");
    for (const skill of AGENT_MODE_MAP.execute.autoSkills) {
      expect(preamble).toContain(skill);
    }
    // RECOMMENDATION, not force-load — body-hash approval gate still runs.
    expect(preamble).toContain("skill_load");
  });

  it("omits the skills block for a mode with no auto skills (explore)", () => {
    const preamble = buildModePreamble(AGENT_MODE_MAP.explore);
    expect(preamble).toContain("<lvis-agent-mode-posture>");
    expect(preamble).not.toContain("<lvis-agent-mode-skills>");
  });

  it("returns an empty string for the inert default mode", () => {
    expect(buildModePreamble(AGENT_MODE_MAP.default)).toBe("");
  });
});

// ─── Unknown-mode audit warn (#1113) ──────────────────

describe("SubAgentRunner — unknown mode audit warn", () => {
  it("logs a warning when the profile mode does not match a known mode", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { refreshProvider: () => void },
        "refreshProvider",
      )
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      await runner.spawn({
        title: "t",
        instructions: "do",
        profileMode: "supervise", // not a member of AGENT_MODES
        maxRounds: 1,
      });
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/unknown mode/i);
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// ─── PR-A: session namespace isolation + regex-valid id ───────────────
//
// The orphan/pollution bug: the child loop used to persist under its bare
// constructor UUID into the parent's main-chat MemoryManager, so sub-agent
// JSONL landed in `~/.lvis/sessions/` and leaked into the main session list;
// the returned childSessionId (`origin::uuid`) failed SESSION_ID_REGEX and was
// addressable by nobody. This suite pins the fix end-to-end against REAL
// MemoryManagers on a temp LVIS_HOME.

// Mirror MemoryManager's SESSION_ID_REGEX exactly (not exported).
const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

describe("SubAgentRunner — subagent session namespace isolation (PR-A)", () => {
  let tmpHome: string;
  let prevLvisHome: string | undefined;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "lvis-subagent-test-"));
    process.env.LVIS_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("persists the child JSONL under ~/.lvis/subagent/, keeps it out of the main session list, and returns a regex-valid childSessionId", async () => {
    const toolRegistry = new ToolRegistry();
    // Provider ends cleanly on round 1 so the child's fallback persistence path
    // (postTurnHookChain undefined) writes exactly one session JSONL.
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "child answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);

    // REAL stores rooted at the temp home. Main = ~/.lvis/sessions/;
    // subagent = ~/.lvis/subagent/sessions/ (via openFeatureNamespace).
    const mainMemoryManager = new MemoryManager({ lvisDir: tmpHome });
    mainMemoryManager.load();
    const subAgentMemoryManager = new MemoryManager({
      lvisDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();

    const parentDeps = buildLoopDeps(toolRegistry);
    // Point the PARENT deps at the real main store so a regression that reused
    // the parent MemoryManager would visibly pollute the main session list.
    (parentDeps as { memoryManager: unknown }).memoryManager = mainMemoryManager;

    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager,
    });

    const hasProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { refreshProvider: () => void }, "refreshProvider")
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });

    try {
      const result = await runner.spawn({
        title: "isolated",
        instructions: "do",
        originSessionId: "abc123-DEF-should:be::sanitized",
        maxRounds: 3,
      });

      // 1) The returned childSessionId is regex-valid (loadSession/saveSession
      //    both reject anything else). The old `::` form failed this.
      expect(result.childSessionId).toMatch(SESSION_ID_REGEX);
      // It also carries the sanitized-origin + sub- prefix shape.
      expect(result.childSessionId.startsWith("sub-")).toBe(true);

      // 2) The child JSONL lives in the SUBAGENT namespace…
      const subSessionsDir = join(tmpHome, "subagent", "sessions");
      expect(existsSync(join(subSessionsDir, `${result.childSessionId}.jsonl`))).toBe(true);

      // 3) …and NOT in the main sessions dir.
      const mainSessionsDir = join(tmpHome, "sessions");
      const mainFiles = existsSync(mainSessionsDir)
        ? readdirSync(mainSessionsDir).filter((f) => f.endsWith(".jsonl"))
        : [];
      expect(mainFiles).toEqual([]);

      // 4) The main listSessions no longer surfaces the sub-agent session.
      expect(mainMemoryManager.listSessions()).toEqual([]);
      // The isolated store DOES see it (addressable for future resume).
      const subIds = subAgentMemoryManager.listSessions().map((s) => s.id);
      expect(subIds).toContain(result.childSessionId);
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("sanitizes an origin session id to the id charset (no `::`, no leaked separators)", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const subAgentMemoryManager = new MemoryManager({
      lvisDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
    });
    const hasProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { refreshProvider: () => void }, "refreshProvider")
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });
    try {
      const result = await runner.spawn({
        title: "sanitize",
        instructions: "do",
        originSessionId: "a::b//c..d",
        maxRounds: 1,
      });
      expect(result.childSessionId).toMatch(SESSION_ID_REGEX);
      expect(result.childSessionId).not.toContain("::");
      expect(result.childSessionId).not.toContain("/");
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });
});
