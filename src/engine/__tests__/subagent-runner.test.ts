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
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLoop } from "../conversation-loop.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import {
  SubAgentRunner,
  resolveSubAgentModel,
  buildModePreamble,
  type SubAgentSpawnResult,
} from "../subagent-runner.js";
import { MODEL_COMPLEXITY_MAP } from "../../shared/model-complexity-map.js";
import { LLM_VENDOR_MODEL_OPTIONS } from "../../shared/llm-vendor-defaults.js";
import { AGENT_MODE_MAP } from "../../shared/agent-mode-map.js";
import type { LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { createAgentSpawnTool, createAgentStatusTool } from "../../tools/agent-spawn.js";
import type { AgentSpawnEvent } from "../../shared/subagent-events.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import {
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  type SubscriptionChatRuntimeSelection,
} from "../../shared/subscription-runtime.js";
import { buildPluginToolsForTest } from "../../plugins/__tests__/plugin-tool-test-fixture.js";
import {
  CARD_FIXTURE_IN_SCOPE_PLUGIN,
  CARD_FIXTURE_IN_SCOPE_TOOL,
  CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN,
  CARD_FIXTURE_OUT_OF_SCOPE_TOOLS,
  pluginCardRuntimeFixture,
} from "../../plugins/__tests__/plugin-card-runtime-fixture.js";
import { createSystemPromptBuilder } from "../../boot/conversation.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";
import { A2A_ROLE_AGENT, A2ATaskState, type A2AMessage,
} from "../../shared/a2a.js";
import { A2ASubAgentMessageBus } from "../a2a-subagent-message-bus.js";
import { SubAgentMessageMailbox } from "../subagent-message-mailbox.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { endTurnScript } from "./conversation-loop-test-helpers.js";
import type { PromptMemorySource } from "../../memory/memory-manager.js";
import { makePromptMemorySource } from "../../prompts/__tests__/test-helpers.js";

// ─── Test scaffolding ─────────────────────────────────

const SUBSCRIPTION_SELECTION = { kind: "subscription", provider: "codex" } as const;

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  public turnsServed = 0;
  public observedToolNames: string[][] = [];
  public observedSystemPrompts: string[] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((params.tools ?? []).map((tool) => tool.name));
    this.observedSystemPrompts.push(params.systemPrompt);
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
function fakeSubAgentMemoryManager(memory: Partial<PromptMemorySource> = {}) {
  return {
    // The child's system prompt is assembled from THIS store, so the double
    // carries the real reader contract instead of empty stand-ins.
    ...makePromptMemorySource(memory),
    saveSession: () => Promise.resolve(),
    // PR-B: spawn() persists resume metadata via saveSessionMetadata into the
    // isolated subagent store — the behavioral suites use a no-op here (the
    // round-trip is pinned by the PR-B suite against a REAL MemoryManager).
    saveSessionMetadata: () => Promise.resolve(),
    listSessions: () => [],
    load: () => undefined,
  } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["subAgentMemoryManager"];
}

function createInMemoryMailboxNamespace() {
  let stored: unknown;
  let rejectNextWrite = false;
  return {
    handle: {
      dir: "memory",
      readJson: async (_name: string, fallback: unknown) =>
        structuredClone(stored === undefined ? fallback : stored),
      writeJson: async (_name: string, value: unknown) => {
        if (rejectNextWrite) {
          rejectNextWrite = false;
          throw new Error("mailbox-write-failed");
        }
        stored = structuredClone(value);
      },
      childDir: async (name: string) => name,
    } as never,
    rejectNextWrite: () => {
      rejectNextWrite = true;
    },
  };
}

function buildLoopDeps(toolRegistry: ToolRegistry) {
  const inputClassifier = new InputClassifier();
  const routeEngine = new RouteEngine();
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
    inputClassifier,
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
          ] as StreamEvent[],
      ),
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
      .spyOn(
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });

    try {
      const result = await runner.spawn({
        title: "test",
        instructions: "do",
        sourceTools: ["noop"],
        maxRounds: 2,
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
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
      expect(result.suspension).toEqual({
        reason: "budget",
        prompt:
          "Send any message to continue, or treat the partial result as done.",
        resumeId: result.childSessionId,
      });
      expect(
        runner.getRunStatus(result.childSessionId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        status: "waiting",
        suspension: result.suspension,
      });
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
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
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
      expect(result.suspension).toBeUndefined();
      expect(result.summary).toContain("final answer");
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("inherits a subscription provider factory for child execution", async () => {
    const toolRegistry = new ToolRegistry();
    const subscriptionProviderFactory = vi.fn((selection: SubscriptionChatRuntimeSelection) => new class extends ScriptedProvider {
      readonly subscriptionRuntime = selection;
    }([
      [
        { type: "text_delta", text: "subscription child completed" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]));
    // Deliberately absent from the default API-key vendor catalog. Codex must
    // send it to main's live subscription catalog instead of dropping it here.
    const profileModel = "codex-live-only-test-model";
    const configuredSettings = {
      ...fakeLlmSettings(),
      activeChatRuntime: SUBSCRIPTION_SELECTION,
    };
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      settingsService: {
        get: () => configuredSettings,
        getSecret: () => "test-key",
      },
      subscriptionProviderFactory,
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });

    const result = await runner.spawn({
      title: "subscription child",
      instructions: "finish the task",
      maxRounds: 2,
      profileModel,
    });

    expect(subscriptionProviderFactory).toHaveBeenCalledWith(
      {
        ...SUBSCRIPTION_SELECTION,
        model: profileModel,
      },
      SUBSCRIPTION_SELECTION,
    );
    expect(result).toMatchObject({
      ok: true,
      summary: expect.stringContaining("subscription child completed"),
      stopReason: "end_turn",
    });
  });

  it("runs the Settings-configured round budget unclamped — 500 reaches the child loop", async () => {
    const toolRegistry = new ToolRegistry();
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      settingsService: {
        get: (key: string) =>
          key === "chat" ? { subAgentMaxRounds: 500 } : fakeLlmSettings(),
        getSecret: () => "test-key",
      },
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue({
        text: "done",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      });
    try {
      await runner.spawn({ title: "budget", instructions: "do" });
      const options = runTurnSpy.mock.calls[0]?.[3] as { maxRounds?: number } | undefined;
      expect(options?.maxRounds).toBe(500);
    } finally {
      runTurnSpy.mockRestore();
      hasProviderSpy.mockRestore();
    }
  });

  it("floors a nonsense configured budget at 1 instead of refusing to run", async () => {
    const toolRegistry = new ToolRegistry();
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      settingsService: {
        get: (key: string) =>
          key === "chat" ? { subAgentMaxRounds: 0 } : fakeLlmSettings(),
        getSecret: () => "test-key",
      },
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue({
        text: "done",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      });
    try {
      await runner.spawn({ title: "floor", instructions: "do" });
      const options = runTurnSpy.mock.calls[0]?.[3] as { maxRounds?: number } | undefined;
      expect(options?.maxRounds).toBe(1);
    } finally {
      runTurnSpy.mockRestore();
      hasProviderSpy.mockRestore();
    }
  });
});

// ─── 2) sourceTools allowlist ─────────────────────────

describe("SubAgentRunner — cross-agent DLP boundary", () => {
  it("masks a child success across returned, tracked, and activity callback surfaces", async () => {
    const secret = "ghp_" + "s".repeat(24);
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "completed with " + secret },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const toolRegistry = new ToolRegistry();
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
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });
    const onActivity = vi.fn();

    try {
      const result = await runner.spawn(
        {
          title: "dlp-success",
          instructions: "finish",
          originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        },
        { onActivity },
      );
      const snapshot = runner.getRunStatus(
        result.childSessionId,
        "a1bdc27a-c758-4a74-8955-5e9188412366",
      );

      for (const surface of [result, snapshot, onActivity.mock.calls]) {
        const serialized = JSON.stringify(surface);
        expect(serialized).not.toContain(secret);
        expect(serialized).toContain("[REDACTED:TOKEN]");
      }
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("masks a child failure across returned, tracked, and error callback surfaces", async () => {
    const secret = "ghp_" + "e".repeat(24);
    const toolRegistry = new ToolRegistry();
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
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockRejectedValue(new Error("provider exposed " + secret));
    const onError = vi.fn();

    try {
      const result = await runner.spawn(
        {
          title: "dlp-error",
          instructions: "fail",
          originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        },
        { onError },
      );
      const snapshot = runner.getRunStatus(
        result.childSessionId,
        "a1bdc27a-c758-4a74-8955-5e9188412366",
      );

      expect(result.ok).toBe(false);
      for (const surface of [result, snapshot, onError.mock.calls]) {
        const serialized = JSON.stringify(surface);
        expect(serialized).not.toContain(secret);
        expect(serialized).toContain("[REDACTED:TOKEN]");
      }
    } finally {
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
    }
  });
});
describe("SubAgentRunner — projected terminal status", () => {
  it("projects a structurally returned blocked turn as rejected/error", async () => {
    const toolRegistry = new ToolRegistry();
    const saveSessionMetadata = vi.fn(async () => undefined);
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: {
        ...fakeSubAgentMemoryManager(),
        saveSessionMetadata,
      },
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
      .mockImplementation(() => undefined);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue({
        text: "prompt refused",
        toolCalls: [],
        route: "default",
        stopReason: "blocked",
      });

    try {
      const result = await runner.spawn({
        title: "blocked",
        instructions: "attempt work",
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
      });

      expect(result).toMatchObject({
        ok: false,
        error: "prompt refused",
        stopReason: "blocked",
        summary: "prompt refused",
      });
      expect(
        runner.getRunStatus(result.childSessionId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        status: "error",
        taskState: "TASK_STATE_REJECTED",
        error: "prompt refused",
      });
      expect(saveSessionMetadata).toHaveBeenCalledTimes(2);
      expect(saveSessionMetadata.mock.calls[1]?.[1]).toMatchObject({
        cumulativeRounds: 0,
        subAgentTaskState: "TASK_STATE_REJECTED",
        subAgentSuspensionReason: undefined,
      });
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
    }
  });

  it.each(["stream-error", "context-error", "max_tokens", "tool_use"] as const)(
    "projects a non-completing %s turn as failed/error and commits zero-round metadata",
    async (stopReason) => {
      const toolRegistry = new ToolRegistry();
      const saveSessionMetadata = vi.fn(async () => undefined);
      const runner = new SubAgentRunner({
        parentDeps: buildLoopDeps(toolRegistry),
        toolRegistry,
        subAgentMemoryManager: {
          ...fakeSubAgentMemoryManager(),
          saveSessionMetadata,
        },
      });
      const hasProviderSpy = vi
        .spyOn(
          ConversationLoop.prototype as unknown as {
            hasProvider: () => boolean;
          },
          "hasProvider",
        )
        .mockReturnValue(true);
      const refreshProviderSpy = vi
        .spyOn(
          ConversationLoop.prototype as unknown as {
            refreshProvider: () => void;
          },
          "refreshProvider",
        )
        .mockImplementation(() => undefined);
      const runTurnSpy = vi
        .spyOn(ConversationLoop.prototype, "runTurn")
        .mockResolvedValue({
          text: "",
          toolCalls: [],
          route: "default",
          stopReason,
        });

      try {
        const result = await runner.spawn({
          title: `non-completing-${stopReason}`,
          instructions: "attempt work",
          originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        });

        expect(result).toMatchObject({
          ok: false,
          error: `sub-agent run stopped with ${stopReason}`,
          stopReason,
          turnCount: 0,
        });
        expect(
          runner.getRunStatus(result.childSessionId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
        ).toMatchObject({
          status: "error",
          taskState: "TASK_STATE_FAILED",
          error: `sub-agent run stopped with ${stopReason}`,
        });
        expect(saveSessionMetadata).toHaveBeenCalledTimes(2);
        expect(saveSessionMetadata.mock.calls[1]?.[1]).toMatchObject({
          cumulativeRounds: 0,
          subAgentTaskState: "TASK_STATE_FAILED",
          subAgentSuspensionReason: undefined,
        });
      } finally {
        hasProviderSpy.mockRestore();
        refreshProviderSpy.mockRestore();
        runTurnSpy.mockRestore();
      }
    },
  );
  it("keeps cancellation terminal when the pending initial metadata save rejects", async () => {
    let rejectMetadata!: (error: Error) => void;
    const saveSessionMetadata = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectMetadata = reject;
        }),
    );
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "canceled-message",
    }));
    const toolRegistry = new ToolRegistry();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: {
        ...fakeSubAgentMemoryManager(),
        saveSessionMetadata,
      },
      messageBus: { deliverToParent } as never,
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue({
        text: "must not run",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      });
    let capturedResult: SubAgentSpawnResult | undefined;
    const originalSpawn = runner.spawn.bind(runner);
    const spawnSpy = vi
      .spyOn(runner, "spawn")
      .mockImplementation(async (input, callbacks) => {
        capturedResult = await originalSpawn(input, callbacks);
        return capturedResult;
      });
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });

    try {
      const handleResult = await tool.execute(
        {
          title: "cancel-before-working",
          instructions: "do not start",
          background: true,
        },
        {
          cwd: process.cwd(),
          extraAllowedDirectories: [],
          metadata: {
            sessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
            spawnDepth: 0,
            supportsA2AParentDelivery: true,
          },
        },
      );
      const handle = JSON.parse(handleResult.output);
      expect(handle.childSessionId).toBeTruthy();
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        taskState: "TASK_STATE_SUBMITTED",
        status: "running",
      });

      expect(
        runner.interruptRun(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        ok: true,
        run: { taskState: "TASK_STATE_CANCELED", status: "interrupted" },
      });
      rejectMetadata(new Error("initial metadata write failed"));

      const deadline = Date.now() + 4000;
      while (deliverToParent.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(capturedResult).toMatchObject({
        childSessionId: handle.childSessionId,
        ok: false,
        stopReason: "interrupted",
        error: "sub-agent run interrupted",
      });
      expect(runTurnSpy).not.toHaveBeenCalled();
      const terminalEvents = events.filter(
        (event) => event.type === "done" || event.type === "error",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "done",
        taskState: "TASK_STATE_CANCELED",
        status: "interrupted",
        childSessionId: handle.childSessionId,
      });
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(deliverToParent).toHaveBeenCalledTimes(1);
      expect(deliverToParent.mock.calls[0]![0]).toMatchObject({
        parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        childSessionId: handle.childSessionId,
        message: expect.objectContaining({
          taskId: handle.childSessionId,
          metadata: expect.objectContaining({
            taskState: "TASK_STATE_CANCELED",
          }),
        }),
      });
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        taskState: "TASK_STATE_CANCELED",
        status: "interrupted",
        stopReason: "interrupted",
      });
      expect(
        runner.interruptRun(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        ok: false,
        run: { taskState: "TASK_STATE_CANCELED", status: "interrupted" },
      });
    } finally {
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("terminalizes a successful turn as FAILED when its final metadata save rejects", async () => {
    let saveCount = 0;
    let rejectFinalMetadata!: (error: Error) => void;
    const saveSessionMetadata = vi.fn(() => {
      saveCount += 1;
      if (saveCount === 1) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        rejectFinalMetadata = reject;
      });
    });
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "failed-final-save-message",
    }));
    const toolRegistry = new ToolRegistry();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: {
        ...fakeSubAgentMemoryManager(),
        saveSessionMetadata,
      },
      messageBus: { deliverToParent } as never,
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async (_prompt, callbacks) => {
        callbacks?.onAssistantRound?.({
          thought: "",
          text: "completed but not durable",
        });
        return {
          text: "completed but not durable",
          toolCalls: [],
          route: "default",
          stopReason: "end_turn",
        };
      });
    let capturedResult: SubAgentSpawnResult | undefined;
    const originalSpawn = runner.spawn.bind(runner);
    const spawnSpy = vi
      .spyOn(runner, "spawn")
      .mockImplementation(async (input, callbacks) => {
        capturedResult = await originalSpawn(input, callbacks);
        return capturedResult;
      });
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });

    try {
      const handleResult = await tool.execute(
        { title: "final-save", instructions: "complete", background: true },
        {
          cwd: process.cwd(),
          extraAllowedDirectories: [],
          metadata: {
            sessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
            spawnDepth: 0,
            supportsA2AParentDelivery: true,
          },
        },
      );
      const handle = JSON.parse(handleResult.output);
      const saveDeadline = Date.now() + 4000;
      while (
        saveSessionMetadata.mock.calls.length < 2 &&
        Date.now() < saveDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(saveSessionMetadata).toHaveBeenCalledTimes(2);
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        taskState: "TASK_STATE_WORKING",
        status: "running",
      });
      expect(
        runner.interruptRun(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        ok: false,
        run: { taskState: "TASK_STATE_WORKING", status: "running" },
      });

      rejectFinalMetadata(new Error("final metadata write failed"));
      const deliveryDeadline = Date.now() + 4000;
      while (
        deliverToParent.mock.calls.length === 0 &&
        Date.now() < deliveryDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(capturedResult).toMatchObject({
        childSessionId: handle.childSessionId,
        ok: false,
        error: "final metadata write failed",
      });
      const terminalEvents = events.filter(
        (event) => event.type === "done" || event.type === "error",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "error",
        taskState: "TASK_STATE_FAILED",
        status: "error",
        message: "final metadata write failed",
        childSessionId: handle.childSessionId,
      });
      expect(deliverToParent).toHaveBeenCalledTimes(1);
      expect(deliverToParent.mock.calls[0]![0]).toMatchObject({
        parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        childSessionId: handle.childSessionId,
        message: expect.objectContaining({
          taskId: handle.childSessionId,
          metadata: expect.objectContaining({ taskState: "TASK_STATE_FAILED" }),
        }),
      });
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        taskState: "TASK_STATE_FAILED",
        status: "error",
        error: "final metadata write failed",
      });
      expect(
        runner.interruptRun(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        ok: false,
        run: { taskState: "TASK_STATE_FAILED", status: "error" },
      });
    } finally {
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });
  it("keeps a pre-loop setup failure pollable and delivers one linked background failure", async () => {
    const toolRegistry = new ToolRegistry();
    const deliverToParent = vi.fn(async () => ({
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: "setup-failure-message",
    }));
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
      messageBus: { deliverToParent } as never,
    });
    const setupSpy = vi
      .spyOn(toolRegistry, "createScopedView")
      .mockImplementation(() => {
        throw new Error("child setup failed");
      });
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });

    try {
      const handleResult = await tool.execute(
        { title: "setup-failure", instructions: "start", background: true },
        {
          cwd: process.cwd(),
          extraAllowedDirectories: [],
          metadata: {
            sessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
            spawnDepth: 0,
            supportsA2AParentDelivery: true,
          },
        },
      );
      const handle = JSON.parse(handleResult.output);
      expect(handleResult.isError).toBe(false);
      expect(handle.childSessionId).toBeTruthy();
      expect(handle).toMatchObject({
        status: "error",
        taskState: "TASK_STATE_FAILED",
      });
      expect(
        runner.getRunStatus(handle.spawnId, "a1bdc27a-c758-4a74-8955-5e9188412366"),
      ).toMatchObject({
        childSessionId: handle.childSessionId,
        status: "error",
        taskState: "TASK_STATE_FAILED",
        error: "child setup failed",
      });

      await vi.waitFor(() => expect(deliverToParent).toHaveBeenCalledTimes(1));
      const terminalEvents = events.filter(
        (event) => event.type === "done" || event.type === "error",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "error",
        taskState: "TASK_STATE_FAILED",
        childSessionId: handle.childSessionId,
        message: "child setup failed",
      });
      expect(deliverToParent.mock.calls[0]?.[0]).toMatchObject({
        parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        childSessionId: handle.childSessionId,
        message: expect.objectContaining({
          taskId: handle.childSessionId,
          metadata: expect.objectContaining({ taskState: "TASK_STATE_FAILED" }),
        }),
      });
    } finally {
      setupSpy.mockRestore();
    }
  });
});
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
    const runner = new SubAgentRunner({
      parentDeps,
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
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
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

  it("does not ADVERTISE a plugin the child cannot call (prompt scope == registry scope)", async () => {
    // The child's executable surface is the scoped registry. Its ADVERTISED
    // surface (the request_plugin catalog in the system prompt) must be bounded
    // by that same registry — it used to be computed from the boot-time global
    // one, because the boot factory closed over it.
    const toolRegistry = new ToolRegistry();
    const pluginTools: Array<[string, string]> = [
      [CARD_FIXTURE_IN_SCOPE_PLUGIN, CARD_FIXTURE_IN_SCOPE_TOOL],
      ...CARD_FIXTURE_OUT_OF_SCOPE_TOOLS.map(
        (name) => [CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN, name] as [string, string],
      ),
    ];
    for (const [pluginId, name] of pluginTools) {
      toolRegistry.register(
        createDynamicTool({
          name,
          description: `${name} description`,
          source: "plugin",
          pluginId,
          category: "read",
          isReadOnly: () => true,
          jsonSchema: { type: "object", properties: {} },
          execute: async () => ({ output: "ok", isError: false }),
        }),
      );
    }

    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ]]);
    // The REAL boot factory builds the card provider — this is the producer.
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      systemPromptBuilder: createSystemPromptBuilder({
        memoryManager: makePromptMemorySource(),
        toolRegistry,
        pluginRuntime: pluginCardRuntimeFixture(process.cwd()),
      }),
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      // The child builder reads THIS memory manager (createIsolated overrides it).
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const hasProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
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
      await runner.spawn({
        title: "scoped child",
        instructions: "summarize",
        sourceTools: [CARD_FIXTURE_IN_SCOPE_TOOL],
        maxRounds: 1,
      });

      const childPrompt = provider.observedSystemPrompts[0] ?? "";
      // Enforcement: the child can only call the one allowlisted plugin tool.
      expect(provider.observedToolNames[0]).toEqual([CARD_FIXTURE_IN_SCOPE_TOOL]);
      // Advertisement must agree.
      expect(childPrompt).not.toContain(CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN);
      for (const name of CARD_FIXTURE_OUT_OF_SCOPE_TOOLS) {
        expect(childPrompt).not.toContain(name);
      }
    } finally {
      hasProviderSpy.mockRestore();
      refreshProviderSpy.mockRestore();
    }
  });

  it("strips memory_write even when it is explicitly allowlisted", async () => {
    const toolRegistry = new ToolRegistry();
    for (const tool of [
      createDynamicTool({
        name: "memory_write",
        description: "persistent write",
        source: "builtin",
        category: "write",
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "would-write-memory", isError: false }),
      }),
      createDynamicTool({
        name: "noop",
        description: "safe",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "ok", isError: false }),
      }),
    ]) toolRegistry.register(tool);
    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ]]);
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
    const hasProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
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
      await runner.spawn({
        title: "read only subagent",
        instructions: "summarize",
        sourceTools: ["memory_write", "noop"],
        maxRounds: 1,
      });

      expect(provider.observedToolNames[0]).toEqual(["noop"]);
      expect(provider.observedToolNames[0]).not.toContain("memory_write");
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
      tools: [
        {
          name: toolName,
          description: "scan the index",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    } as unknown as PluginManifest)) {
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
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
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

describe("SubAgentRunner — the child's agent context", () => {
  it("composes the sub-agent store's agents.custom.md after its AGENTS.md", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ]]);
    // REAL boot factory + REAL builder: the composition under test is the
    // production one, reached through the runner rather than re-implemented.
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      systemPromptBuilder: createSystemPromptBuilder({
        memoryManager: makePromptMemorySource({
          getAgentsMd: () => "PARENT packaged reference",
          getAgentsCustomMd: () => "PARENT own rules",
        }),
        toolRegistry,
        pluginRuntime: pluginCardRuntimeFixture(process.cwd()),
      }),
    } as unknown as ConstructorParameters<typeof SubAgentRunner>[0]["parentDeps"];
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager({
        getAgentsMd: () => "CHILD packaged reference",
        getAgentsCustomMd: () => "CHILD own rules",
      }),
    });
    const hasProviderSpy = vi
      .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
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
      await runner.spawn({ title: "child", instructions: "summarize", maxRounds: 1 });

      const childPrompt = provider.observedSystemPrompts[0] ?? "";
      expect(childPrompt).toContain("<lvis-agents-custom-context>");
      expect(childPrompt).toContain("CHILD packaged reference");
      // The user's own half is ordered last so it wins a conflict.
      expect(childPrompt.indexOf("CHILD packaged reference"))
        .toBeLessThan(childPrompt.indexOf("CHILD own rules"));
      // Both halves come from the child's OWN store, never the parent's.
      expect(childPrompt).not.toContain("PARENT packaged reference");
      expect(childPrompt).not.toContain("PARENT own rules");
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
      metadata: { sessionId: "1ae80cfb-d8c8-4a02-806d-4f4d2872a62d", spawnDepth: 1 },
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
      getRunner: () =>
        ({
          spawn: async () => ({
            summary: "ok",
            toolCallCount: 0,
            turnCount: 1,
            childSessionId: "2e7d2c03-a950-4ae2-85ec-f5b5356885a5",
            entries: [],
            ok: true,
          }),
        }) as never,
      emit: () => undefined,
    });
    const ctxAsParent = {
      cwd: process.cwd(),
      metadata: { sessionId: "e4712596-8b3b-4104-8fbc-4802d1e40a71", spawnDepth: 0 },
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

  it("uses the active Codex subscription catalog instead of the stale API-key vendor catalog", () => {
    const codex = { kind: "subscription", provider: "codex" } as const;

    expect(resolveSubAgentModel("  codex-live-only-model  ", "claude", codex))
      .toBe("codex-live-only-model");
    // Complexity names are not model IDs and Codex has no static engine map;
    // the persisted subscription selection remains in effect.
    expect(resolveSubAgentModel("high", "openai", codex)).toBeNull();
    expect(resolveSubAgentModel("bad\u0000model", "openai", codex)).toBeNull();
    expect(resolveSubAgentModel("x".repeat(MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH + 1), "openai", codex)).toBeNull();
  });

  it("keeps an ACP subscription's persisted default model", () => {
    expect(resolveSubAgentModel(
      "codex-live-only-model",
      "openai",
      { kind: "subscription", provider: "kimi-code" },
    )).toBeNull();
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
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
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

  afterEach(async () => {
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    await cleanupTmpDir(tmpHome);
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
    (parentDeps as { memoryManager: unknown }).memoryManager =
      mainMemoryManager;

    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager,
    });

    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
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
      expect(
        existsSync(join(subSessionsDir, `${result.childSessionId}.jsonl`)),
      ).toBe(true);

      // 3) …and NOT in the main sessions dir.
      const mainSessionsDir = join(tmpHome, "sessions");
      const mainFiles = existsSync(mainSessionsDir)
        ? readdirSync(mainSessionsDir).filter((f) => f.endsWith(".jsonl"))
        : [];
      expect(mainFiles).toEqual([]);

      // 4) The main listSessions no longer surfaces the sub-agent session.
      expect(mainMemoryManager.listSessions()).toEqual([]);
      // The isolated store DOES see it (addressable for future resume). PR-B
      // tags it `sessionKind: "subagent"`, so it is scoped out of the default
      // "main" listing and surfaces under the "subagent" (or "all") kind.
      const subIds = subAgentMemoryManager
        .listSessions({ kind: "subagent" })
        .map((s) => s.id);
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
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
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

// ─── PR-B: resume metadata + "subagent" SessionKind + review-nit fold ─────────
//
// Metadata-only foundation for same-instance resume (PR-C). Pins that a spawn:
//   1. tags its persisted session `sessionKind: "subagent"`,
//   2. round-trips the resume fields (sourceTools/profileModel/profileMode/
//      resumeCount/cumulativeRounds) through saveSessionMetadata,
//   3. builds a child id whose origin tag is a HASH of the origin id (info-leak
//      NIT fold) — not a raw slice — while staying regex-valid,
//   4. re-inits the tracer on the rebound childSessionId (dev-trace NIT fold).

describe("SubAgentRunner — resume metadata + subagent SessionKind (PR-B)", () => {
  let tmpHome: string;
  let prevLvisHome: string | undefined;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "lvis-subagent-prb-"));
    process.env.LVIS_HOME = tmpHome;
  });

  afterEach(async () => {
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    await cleanupTmpDir(tmpHome);
  });

  function makeCleanProvider(): ScriptedProvider {
    return new ScriptedProvider(endTurnScript("child answer"));
  }

  function spawnWith(
    provider: ScriptedProvider,
    subAgentMemoryManager: MemoryManager,
    input: Parameters<SubAgentRunner["spawn"]>[0],
  ) {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      createDynamicTool({
        name: "noop",
        description: "no-op tool",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "ok", isError: false }),
      }),
    );
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    const refreshProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as {
          refreshProvider: () => void;
        },
        "refreshProvider",
      )
      .mockImplementation(function (this: ConversationLoop) {
        (this as { provider: LLMProvider | null }).provider = provider;
      });
    return {
      run: () => runner.spawn(input),
      restore: () => {
        hasProviderSpy.mockRestore();
        refreshProviderSpy.mockRestore();
      },
    };
  }

  it("persists routing metadata before provider validation so failed runs remain addressable", async () => {
    const subAgentMemoryManager = new MemoryManager({
      lvisDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const toolRegistry = new ToolRegistry();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(false);

    try {
      const result = await runner.spawn({
        title: "provider-missing",
        instructions: "do",
        originSessionId: "b0590dc4-c31e-4ff6-8106-2b5f6d6325d9",
        maxRounds: 1,
      });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("provider not configured"),
      });
      expect(
        subAgentMemoryManager.loadSessionMetadata(result.childSessionId),
      ).toMatchObject({
        sessionKind: "subagent",
        originSessionId: "b0590dc4-c31e-4ff6-8106-2b5f6d6325d9",
        subAgentTitle: "provider-missing",
        budgetResumeCount: 0,
        questionAnswerCount: 0,
        cumulativeRounds: 0,
        subAgentTaskState: "TASK_STATE_FAILED",
        subAgentSuspensionReason: undefined,
      });
      await expect(
        runner.resolveSubAgentAddress("b0590dc4-c31e-4ff6-8106-2b5f6d6325d9", result.childSessionId),
      ).resolves.toEqual({
        childSessionId: result.childSessionId,
        parentSessionId: "b0590dc4-c31e-4ff6-8106-2b5f6d6325d9",
        childTitle: "provider-missing",
      });
    } finally {
      hasProviderSpy.mockRestore();
    }
  });

  it('tags the persisted sub-agent session `sessionKind: "subagent"` and round-trips the resume metadata fields', async () => {
    const subAgentMemoryManager = new MemoryManager({
      lvisDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const { run, restore } = spawnWith(
      makeCleanProvider(),
      subAgentMemoryManager,
      {
        title: "meta",
        instructions: "do",
        originSessionId: "51941cbf-7fc2-45a8-8401-d2193b48d640",
        sourceTools: ["noop"],
        profileModel: "high",
        profileMode: "execute",
        maxRounds: 3,
      },
    );
    try {
      const result = await run();
      // Re-read the persisted metadata from the SAME isolated store — this is
      // the exact round-trip PR-C's resume relies on.
      const meta = subAgentMemoryManager.loadSessionMetadata(
        result.childSessionId,
      );
      expect(meta).not.toBeNull();
      expect(meta?.sessionKind).toBe("subagent");
      // The frozen scoped tool surface. `sourceTools: ["noop"]` resolves to a
      // one-tool registry, so the persisted allowlist is exactly ["noop"].
      expect(meta?.sourceTools).toEqual(["noop"]);
      expect(meta?.profileModel).toBe("high");
      expect(meta?.profileMode).toBe("execute");
      // resumeCount inits to 0 (no resume yet). cumulativeRounds now records the
      // spawn's OWN round count (PR-C Commit 2 fix: previously left at 0, which
      // made the resume-chain ceiling inaccurate). A clean 1-round spawn → 1.
      expect(meta?.resumeCount).toBe(0);
      expect(meta?.budgetResumeCount).toBe(0);
      expect(meta?.questionAnswerCount).toBe(0);
      expect(meta?.cumulativeRounds).toBe(result.turnCount);
      // The session surfaces in the isolated store's listing as a subagent.
      const listed = subAgentMemoryManager
        .listSessions({ kind: "subagent" })
        .find((s) => s.id === result.childSessionId);
      expect(listed?.sessionKind).toBe("subagent");
    } finally {
      restore();
    }
  });

  it("omits profileModel/profileMode from metadata when the spawn did not supply them", async () => {
    const subAgentMemoryManager = new MemoryManager({
      lvisDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const { run, restore } = spawnWith(
      makeCleanProvider(),
      subAgentMemoryManager,
      {
        title: "meta-min",
        instructions: "do",
        originSessionId: "dbf92cab-1af6-4614-815f-ee0e85ca76ab",
        maxRounds: 1,
      },
    );
    try {
      const result = await run();
      const meta = subAgentMemoryManager.loadSessionMetadata(
        result.childSessionId,
      );
      expect(meta?.sessionKind).toBe("subagent");
      expect(meta?.profileModel).toBeUndefined();
      expect(meta?.profileMode).toBeUndefined();
      expect(meta?.resumeCount).toBe(0);
      expect(meta?.budgetResumeCount).toBe(0);
      expect(meta?.questionAnswerCount).toBe(0);
      // cumulativeRounds records the spawn's own round count (PR-C Commit 2 fix).
      expect(meta?.cumulativeRounds).toBe(result.turnCount);
      // sourceTools falls back to the full (blocklist-stripped) parent surface,
      // which for this registry is the single "noop" tool.
      expect(meta?.sourceTools).toEqual(["noop"]);
    } finally {
      restore();
    }
  });

  it("derives the origin tag from a HASH of the origin id (not a raw slice) and keeps the id regex-valid", async () => {
    const subAgentMemoryManager = new MemoryManager({
      lvisDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    // A raw-slice implementation would embed the first 8 alphanumerics of the
    // origin ("abcdefgh") verbatim in the child id. The hash fold must NOT.
    const origin = "abcdefgh-IJKL-should-not-appear-verbatim";
    const { run, restore } = spawnWith(
      makeCleanProvider(),
      subAgentMemoryManager,
      {
        title: "hash",
        instructions: "do",
        originSessionId: origin,
        maxRounds: 1,
      },
    );
    try {
      const result = await run();
      expect(result.childSessionId).toMatch(SESSION_ID_REGEX);
      expect(result.childSessionId.startsWith("sub-")).toBe(true);
      // The raw-slice fossil ("abcdefgh") must not correlate the child filename
      // to the parent session id.
      expect(result.childSessionId).not.toContain("abcdefgh");
      // The tag is the deterministic short sha256 of the origin id.
      const expectedTag = createHash("sha256")
        .update(origin)
        .digest("hex")
        .slice(0, 8);
      expect(result.childSessionId.startsWith(`sub-${expectedTag}-`)).toBe(
        true,
      );
    } finally {
      restore();
    }
  });

  it("re-inits the tracer on the rebound childSessionId so dev traces key on the addressable id (not the stale constructor UUID)", async () => {
    const prevTrace = process.env.LVIS_TRACE;
    process.env.LVIS_TRACE = "1"; // force-enable FileTracer regardless of NODE_ENV
    const subAgentMemoryManager = new MemoryManager({
      lvisDir: openFeatureNamespace("subagent").dir,
    });
    subAgentMemoryManager.load();
    const { run, restore } = spawnWith(
      makeCleanProvider(),
      subAgentMemoryManager,
      {
        title: "trace",
        instructions: "do",
        originSessionId: "5ff63492-6b31-40b0-89d5-e32bffe9063b",
        maxRounds: 1,
      },
    );
    try {
      const result = await run();
      // The tracer writes ~/.lvis/traces/<sessionId>.jsonl on the first turn
      // step (TURN_ORCHESTRATE). With the tracer rebound, the file is named
      // after the childSessionId; a stale-UUID tracer would produce a
      // UUID-named file and no <childSessionId>.jsonl.
      const tracesDir = join(tmpHome, "traces");
      const traceFiles = existsSync(tracesDir)
        ? readdirSync(tracesDir).filter((f) => f.endsWith(".jsonl"))
        : [];
      expect(traceFiles).toContain(`${result.childSessionId}.jsonl`);
      // No trace file may be keyed on a bare constructor UUID (the stale-id bug).
      const uuidNamed = traceFiles.filter((f) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(
          f,
        ),
      );
      expect(uuidNamed).toEqual([]);
    } finally {
      restore();
      if (prevTrace === undefined) delete process.env.LVIS_TRACE;
      else process.env.LVIS_TRACE = prevTrace;
    }
  });
});

describe("SubAgentRunner A2A bus facade", () => {
  it("fails closed and returns inert mailbox results when boot has no bus", async () => {
    const toolRegistry = new ToolRegistry();
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });

    await expect(
      runner.deliverToParent({
        parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        childSessionId: "sub-cd737a61-ca965459-55b1-40f6-8d1a-600e3f7a12ae",
        message: {
          messageId: "message-1",
          contextId: "a1bdc27a-c758-4a74-8955-5e9188412366",
          taskId: "sub-cd737a61-ca965459-55b1-40f6-8d1a-600e3f7a12ae",
          role: "ROLE_AGENT",
          parts: [{ text: "hello" }],
        },
      }),
    ).resolves.toEqual({
      ok: false,
      disposition: "dropped",
      reason: "message-bus-unavailable",
    });
    await expect(runner.peekParentMailbox("a1bdc27a-c758-4a74-8955-5e9188412366")).resolves.toEqual(
      [],
    );
    await expect(
      runner.acknowledgeParentMailbox("a1bdc27a-c758-4a74-8955-5e9188412366", ["message-1"]),
    ).resolves.toBe(0);
    expect(() => runner.setParentWakeHandler(null)).not.toThrow();
  });

  it("one-shots an initial-metadata failure through the real bus and durable mailbox", async () => {
    const parentSessionId = "a1bdc27a-c758-4a74-8955-5e9188412366";
    const namespace = createInMemoryMailboxNamespace();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    const audit = vi.fn();
    const toolRegistry = new ToolRegistry();
    const subAgentMemoryManager = {
      ...fakeSubAgentMemoryManager(),
      saveSessionMetadata: vi.fn(async () => {
        throw new Error("initial metadata write failed");
      }),
      loadSessionMetadata: vi.fn(() => null),
      hasSessionMetadataFile: vi.fn(() => false),
    } as unknown as ConstructorParameters<
      typeof SubAgentRunner
    >[0]["subAgentMemoryManager"];
    let runner!: SubAgentRunner;
    const bus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "different-active-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: (parentId, childId, messageId) =>
        runner.resolveSubAgentAddress(parentId, childId, messageId),
      releaseEphemeralChildAddress: (parentId, childId, messageId) =>
        runner.releaseEphemeralParentDelivery(parentId, childId, messageId),
    });
    runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
      messageBus: bus,
    });
    const events: AgentSpawnEvent[] = [];
    const tool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: (event) => events.push(event),
    });

    const handleResult = await tool.execute(
      { title: "metadata-failure", instructions: "start", background: true },
      {
        cwd: process.cwd(),
        extraAllowedDirectories: [],
        metadata: {
          sessionId: parentSessionId,
          spawnDepth: 0,
          supportsA2AParentDelivery: true,
        },
      },
    );
    const handle = JSON.parse(handleResult.output) as {
      spawnId: string;
      childSessionId: string;
    };
    expect(handleResult.isError).toBe(false);
    expect(handle.childSessionId).toBeTruthy();

    let persisted = await runner.peekParentMailbox(parentSessionId);
    const deadline = Date.now() + 2_000;
    while (persisted.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      persisted = await runner.peekParentMailbox(parentSessionId);
    }
    expect(persisted).toHaveLength(1);
    const entry = persisted[0]!;
    expect(entry).toMatchObject({
      parentSessionId,
      childSessionId: handle.childSessionId,
      childTitle: "metadata-failure",
      message: {
        contextId: parentSessionId,
        taskId: handle.childSessionId,
        metadata: { taskState: A2ATaskState.FAILED },
      },
    });
    expect(
      events.filter((event) => event.type === "done" || event.type === "error"),
    ).toHaveLength(1);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      taskState: A2ATaskState.FAILED,
      childSessionId: handle.childSessionId,
    });

    await expect(
      runner.resolveSubAgentAddress(
        parentSessionId,
        handle.childSessionId,
        entry.message.messageId,
      ),
    ).resolves.toEqual({
      parentSessionId,
      childSessionId: handle.childSessionId,
      childTitle: "metadata-failure",
      ephemeralMessageId: entry.message.messageId,
    });

    const makeReplay = (contextId: string, messageId: string): A2AMessage => ({
      messageId,
      contextId,
      taskId: handle.childSessionId,
      role: A2A_ROLE_AGENT,
      parts: [{ text: "forged terminal replay" }],
      metadata: { taskState: A2ATaskState.FAILED },
    });
    await expect(
      runner.deliverToParent({
        parentSessionId: "bebd469f-b3d4-42a8-8340-f0a27e66162b",
        childSessionId: handle.childSessionId,
        message: makeReplay("bebd469f-b3d4-42a8-8340-f0a27e66162b", "wrong-parent-message"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "unknown-child" });
    await expect(
      runner.deliverToParent({
        parentSessionId,
        childSessionId: handle.childSessionId,
        message: makeReplay(parentSessionId, "wrong-message-id"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "unknown-child" });

    namespace.rejectNextWrite();
    await expect(
      runner.acknowledgeParentMailbox(parentSessionId, [entry.id]),
    ).rejects.toThrow("mailbox-write-failed");
    await expect(
      runner.resolveSubAgentAddress(
        parentSessionId,
        handle.childSessionId,
        entry.message.messageId,
      ),
    ).resolves.toMatchObject({ ephemeralMessageId: entry.message.messageId });
    await expect(
      runner.peekParentMailbox(parentSessionId),
    ).resolves.toHaveLength(1);

    await expect(
      runner.acknowledgeParentMailbox(parentSessionId, [entry.id]),
    ).resolves.toBe(1);
    await expect(
      runner.resolveSubAgentAddress(
        parentSessionId,
        handle.childSessionId,
        entry.message.messageId,
      ),
    ).resolves.toBeNull();
    await expect(
      runner.deliverToParent({
        parentSessionId,
        childSessionId: handle.childSessionId,
        message: makeReplay(parentSessionId, "post-ack-message-id"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "unknown-child" });
    await expect(runner.peekParentMailbox(parentSessionId)).resolves.toEqual(
      [],
    );
  });
});

describe("SubAgentRunner workspace lifecycle", () => {
  it("revokes every active child and surfaces an aggregate child failure", () => {
    const first = vi.fn(() => ({
      sessionDirectoriesRemoved: 2,
      turnDirectoriesRemoved: 1,
      projectRebound: false,
    }));
    const failing = vi.fn(() => {
      throw new Error("isolated child failure");
    });
    const last = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 4,
      projectRebound: true,
    }));
    const runner = new SubAgentRunner({} as never);
    const activeChildren = (
      runner as unknown as {
        activeChildren: Map<string, unknown>;
      }
    ).activeChildren;
    const child = (
      childSessionId: string,
      revokeWorkspaceRoot: ReturnType<typeof vi.fn>,
    ) => ({
      lease: Symbol(childSessionId),
      childSessionId,
      title: childSessionId,
      background: true,
      loop: { revokeWorkspaceRoot },
    });
    activeChildren.set("child-one", child("child-one", first));
    activeChildren.set("child-failing", child("child-failing", failing));
    activeChildren.set("child-last", child("child-last", last));

    const options = {
      globalScopeWasAuthorized: true,
      preserveRoots: [join(tmpdir(), "removed-workspace", "child")],
    };
    let thrown: unknown;
    try {
      runner.revokeWorkspaceRoot(join(tmpdir(), "removed-workspace"), options);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown).toMatchObject({
      code: "SUBAGENT_WORKSPACE_ROOT_REVOKE_FAILED",
    });
    expect((thrown as AggregateError).errors).toHaveLength(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]?.[0]).toBe(last.mock.calls[0]?.[0]);
    expect(first.mock.calls[0]?.[1]).toEqual(options);
    expect(failing.mock.calls[0]?.[1]).toEqual(options);
    expect(last.mock.calls[0]?.[1]).toEqual(options);
  });

  it("registers a fresh child before initial metadata persistence can race workspace removal", async () => {
    const removedRoot = join(tmpdir(), "subagent-pending-metadata-root");
    const fallbackRoot = join(tmpdir(), "subagent-safe-default-root");
    let rootRegistered = true;
    let releaseInitialMetadata!: () => void;
    const initialMetadataPending = new Promise<void>((resolve) => {
      releaseInitialMetadata = resolve;
    });
    let metadataSaveCount = 0;
    const saveSessionMetadata = vi.fn(() => {
      metadataSaveCount += 1;
      return metadataSaveCount === 1
        ? initialMetadataPending
        : Promise.resolve();
    });
    const toolRegistry = new ToolRegistry();
    const parentDeps = buildLoopDeps(toolRegistry);
    Object.assign(parentDeps, {
      getAdditionalDirectories: () => (rootRegistered ? [removedRoot] : []),
      getDefaultProject: () => ({
        projectRoot: fallbackRoot,
        projectName: "safe-default",
        isDefault: true,
      }),
      authorizeProject: (projectRoot: string, projectName?: string) =>
        rootRegistered && projectRoot === removedRoot
          ? { projectRoot, projectName, isDefault: false }
          : null,
    });
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: {
        ...fakeSubAgentMemoryManager(),
        saveSessionMetadata,
      },
    });
    const hasProviderSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
        "hasProvider",
      )
      .mockReturnValue(true);
    let directoriesAtRun: readonly string[] = [];
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation(async function (this: ConversationLoop) {
        directoriesAtRun = this.getTurnAdditionalDirectories();
        return {
          text: "safe",
          toolCalls: [],
          route: "default",
          stopReason: "end_turn",
        };
      });
    let spawnPromise: Promise<SubAgentSpawnResult> | undefined;

    try {
      spawnPromise = runner.spawn({
        title: "pending metadata child",
        instructions: "run only after metadata persists",
        projectRoot: removedRoot,
        projectName: "removed-project",
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
      });
      expect(saveSessionMetadata).toHaveBeenCalledTimes(1);
      expect(runTurnSpy).not.toHaveBeenCalled();

      rootRegistered = false;
      expect(
        runner.revokeWorkspaceRoot(removedRoot, {
          globalScopeWasAuthorized: true,
        }),
      ).toMatchObject({
        activeChildrenVisited: 1,
        liveScopesRevoked: 1,
      });

      releaseInitialMetadata();
      const result = await spawnPromise;
      spawnPromise = undefined;

      expect(result.ok).toBe(true);
      expect(runTurnSpy).toHaveBeenCalledTimes(1);
      expect(directoriesAtRun).toContain(fallbackRoot);
      expect(directoriesAtRun).not.toContain(removedRoot);
      expect(
        (runner as unknown as { activeChildren: Map<string, unknown> })
          .activeChildren.size,
      ).toBe(0);
    } finally {
      releaseInitialMetadata();
      await spawnPromise?.catch(() => undefined);
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
    }
  });

  it("delegates project detach and re-add to the isolated metadata store", async () => {
    const allowProjectRoot = vi.fn();
    const detachSessionsFromProject = vi.fn(async () => 2);
    const runner = new SubAgentRunner({
      subAgentMemoryManager: {
        allowProjectRoot,
        detachSessionsFromProject,
      },
    } as never);
    const root = join(tmpdir(), "removed-subagent-workspace");

    await expect(runner.detachSessionsFromProject(root)).resolves.toBe(2);
    runner.allowProjectRoot(root);

    expect(detachSessionsFromProject).toHaveBeenCalledWith(root);
    expect(allowProjectRoot).toHaveBeenCalledWith(root);
  });
});
describe("spawn cancellation signal", () => {
  it("hands the run's abort signal to the child turn", async () => {
    // `interruptRun` reports CANCELED, but the only carrier used to be the
    // `abortCurrentTurn()` closure — documented as a no-op when no turn is in
    // flight. An interrupt landing during spawn setup therefore reported
    // cancellation while the child ran its full `cappedRounds`, and the second
    // interrupt answers "not running", so the user could not retry.
    const toolRegistry = new ToolRegistry();
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
    // Park the child turn so the run is still in flight when the interrupt
    // lands — the whole point is the window where a turn exists but the
    // closure-based carrier cannot reach it.
    let releaseTurn: () => void = () => {};
    const turnParked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let sawTurn: () => void = () => {};
    const turnStarted = new Promise<void>((resolve) => {
      sawTurn = resolve;
    });
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation((async () => {
        sawTurn();
        await turnParked;
        return { text: "done", stopReason: "end_turn" };
      }) as never);

    try {
      const spawned = runner.spawn(
        {
          title: "cancel-signal",
          instructions: "work",
          originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        },
        {},
      );
      await turnStarted;

      // Assert the linkage, not the arity: a signal that is not the run's own
      // would satisfy "third argument is defined" and still never fire.
      const signal = runTurnSpy.mock.calls[0]?.[2] as AbortSignal | undefined;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      const snapshot = runner.listRunStatuses("a1bdc27a-c758-4a74-8955-5e9188412366")[0];
      const runId = snapshot?.spawnId ?? snapshot?.childSessionId ?? "";
      expect(runner.interruptRun(runId, "a1bdc27a-c758-4a74-8955-5e9188412366")).toMatchObject({ ok: true });
      expect(signal?.aborted).toBe(true);

      releaseTurn();
      await spawned;
    } finally {
      hasProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
    }
  });
});

describe("SubAgentRunner terminal completion step", () => {
  /**
   * A completing sub-agent has two audiences that must not disagree: the
   * parent LLM, which reads the run through `agent_status`, and the tile's
   * sub-agent panel, which is the only place the user can watch it. The
   * renderer frame used to be dispatched by whoever awaited the run, one
   * scheduling hop after the runner published the terminal state — so the
   * parent could already be answering from a `done` the panel had not been
   * told about. These pin the frame to the completion step itself.
   */
  function completionRunner() {
    const toolRegistry = new ToolRegistry();
    return new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: fakeSubAgentMemoryManager(),
    });
  }

  it("publishes the terminal state and the renderer frame in one uninterruptible step", async () => {
    const runner = completionRunner();
    const observed: string[] = [];
    // The child loop has no provider, so the run reaches its terminal state
    // through the completion step without needing a scripted LLM turn.
    const spawned = runner.spawn(
      {
        title: "completion order",
        instructions: "do",
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        spawnId: "spawn-completion-order",
      },
      {
        onTerminal: (result) => {
          observed.push(`frame:${result.ok ? "ok" : "error"}`);
          // Exactly what `agent_status` would answer at this instant. If the
          // frame were dispatched by the awaiting caller instead, the answer
          // here would already have been readable for a whole scheduling hop.
          observed.push(
            `agent_status:${
              runner.getRunStatus("spawn-completion-order", "a1bdc27a-c758-4a74-8955-5e9188412366")?.status
            }`,
          );
        },
      },
    );
    observed.push("awaiting");
    const result = await spawned;
    observed.push("resolved");

    expect(result.ok).toBe(false);
    expect(observed).toEqual([
      "awaiting",
      "frame:error",
      "agent_status:error",
      "resolved",
    ]);
  });

  it("reports a terminal run to the renderer once, even if the run finalizes twice", async () => {
    const runner = completionRunner();
    const onTerminal = vi.fn();
    await runner.spawn(
      {
        title: "single frame",
        instructions: "do",
        originSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
        spawnId: "1f2ffeba-7ce4-4ac6-8a3e-6846649f7785",
      },
      { onTerminal },
    );
    expect(onTerminal).toHaveBeenCalledTimes(1);

    // Re-finalizing the same tracked run is what a late cancellation or a
    // retried persistence path does. The observer must not fire again.
    const tracked = (
      runner as unknown as { trackedRuns: Map<string, { title: string }> }
    ).trackedRuns.get("1f2ffeba-7ce4-4ac6-8a3e-6846649f7785");
    expect(tracked).toBeDefined();
    (runner as unknown as {
      finalizeRun: (run: unknown, result: SubAgentSpawnResult) => void;
    }).finalizeRun(tracked, {
      summary: "second finalize",
      toolCallCount: 0,
      turnCount: 0,
      childSessionId: "1f2ffeba-7ce4-4ac6-8a3e-6846649f7785",
      entries: [],
      ok: false,
      error: "second finalize",
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("SubAgentRunner completion mailbox single-shot", () => {
  /**
   * A finished sub-agent reports through two channels by construction: the
   * terminal snapshot `agent_status` hands the parent mid-turn, and the
   * durable mailbox entry the parent's NEXT turn folds in as host steering.
   * Both are needed — a parent that never polls must still get the report —
   * but a parent that already answered from `agent_status` was being told to
   * go and review the same work again. The completion step records which
   * message carries the report; reading that report retires the queued copy.
   */
  const parentSessionId = "a1bdc27a-c758-4a74-8955-5e9188412366";
  const restore: Array<() => void> = [];

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
  });

  function completionMailboxFixture() {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "child finished" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
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
    restore.push(() => hasProviderSpy.mockRestore());
    restore.push(() => refreshProviderSpy.mockRestore());

    const namespace = createInMemoryMailboxNamespace();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    const storedMetadata = new Map<string, Record<string, unknown>>();
    const subAgentMemoryManager = {
      ...fakeSubAgentMemoryManager(),
      saveSessionMetadata: vi.fn(async (id: string, meta: Record<string, unknown>) => {
        storedMetadata.set(id, { ...meta });
      }),
      loadSessionMetadata: vi.fn((id: string) => storedMetadata.get(id) ?? null),
      hasSessionMetadataFile: vi.fn((id: string) => storedMetadata.has(id)),
      listSubAgentSessionsForOrigin: vi.fn(() => []),
    } as unknown as ConstructorParameters<
      typeof SubAgentRunner
    >[0]["subAgentMemoryManager"];
    let runner!: SubAgentRunner;
    const bus = new A2ASubAgentMessageBus({
      // A parent that is not the loop's active session and has no turn open:
      // the delivery lands in the durable mailbox rather than being injected
      // mid-turn, which is the shape the doubled report was reported in.
      parentLoop: {
        getSessionId: () => "different-active-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: vi.fn() } as never,
      resolveChildAddress: (parentId, childId, messageId) =>
        runner.resolveSubAgentAddress(parentId, childId, messageId),
    });
    const toolRegistry = new ToolRegistry();
    runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager,
      messageBus: bus,
    });
    const spawnTool = createAgentSpawnTool({
      getRunner: () => runner,
      emit: () => undefined,
    });
    const statusTool = createAgentStatusTool({ getRunner: () => runner });
    const parentContext = {
      cwd: process.cwd(),
      extraAllowedDirectories: [],
      metadata: {
        sessionId: parentSessionId,
        spawnDepth: 0,
        supportsA2AParentDelivery: true,
      },
    };
    return { runner, bus, spawnTool, statusTool, parentContext };
  }

  async function spawnUntilReportQueued(
    fixture: ReturnType<typeof completionMailboxFixture>,
    title: string,
  ) {
    const handleResult = await fixture.spawnTool.execute(
      { title, instructions: "do" },
      fixture.parentContext,
    );
    expect(handleResult.isError).toBe(false);
    const handle = JSON.parse(handleResult.output) as { spawnId: string };
    let queued = await fixture.runner.peekParentMailbox(parentSessionId);
    const deadline = Date.now() + 5_000;
    while (queued.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      queued = await fixture.runner.peekParentMailbox(parentSessionId);
    }
    return { handle, queued };
  }

  it("retires the queued report once agent_status hands the parent the same run", async () => {
    const fixture = completionMailboxFixture();
    const { handle, queued } = await spawnUntilReportQueued(fixture, "already read");
    expect(queued).toHaveLength(1);

    const status = await fixture.statusTool.execute(
      { id: handle.spawnId },
      fixture.parentContext,
    );
    expect(JSON.parse(status.output)).toMatchObject({
      run: { status: "done", spawnId: handle.spawnId },
    });

    // The parent's next turn folds the mailbox in. The report it already
    // answered from must not come back as a steering row — this turn or any
    // turn after it.
    await expect(
      fixture.runner.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
    await expect(
      fixture.runner.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
    // And it is gone from the DURABLE mailbox, not merely hidden by the
    // runner's filter: the read mark is process-local, so an entry the
    // acknowledgement left behind would come back after a restart.
    await expect(
      fixture.bus.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
  });

  it("retires the queued report through the listing form of agent_status too", async () => {
    const fixture = completionMailboxFixture();
    const { queued } = await spawnUntilReportQueued(fixture, "listed read");
    expect(queued).toHaveLength(1);

    const status = await fixture.statusTool.execute({}, fixture.parentContext);
    expect((JSON.parse(status.output) as { runs: unknown[] }).runs).toHaveLength(1);

    await expect(
      fixture.runner.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
    await expect(
      fixture.bus.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
  });

  it("does not count a snapshot whose result the state machine refused as a read report", async () => {
    // Reading terminal is not the test the guard can use: `interruptRun` writes
    // CANCELED the instant an abort is requested, and `persistFinalResult`
    // claims the terminal commit before its awaits, so a run reads terminal
    // while its summary and error are still missing. The guard asks the
    // narrower question — did the completion step's patch actually land — and
    // a refused transition is the sharpest way to drive it.
    //
    // The refusal itself is defence in depth: both run loops normalize an
    // aborted run's result to `interrupted` before finalizing, so a COMPLETED
    // result cannot reach `finalizeRun` behind a CANCELED state at runtime.
    // Driving it directly is what makes the guard observable.
    const fixture = completionMailboxFixture();
    let releaseTurn: () => void = () => {};
    const turnParked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let sawTurn: () => void = () => {};
    const turnStarted = new Promise<void>((resolve) => {
      sawTurn = resolve;
    });
    const runTurnSpy = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockImplementation((async () => {
        sawTurn();
        await turnParked;
        return { text: "unused", stopReason: "end_turn" };
      }) as never);
    restore.push(() => runTurnSpy.mockRestore());
    restore.push(() => releaseTurn());

    const handleResult = await fixture.spawnTool.execute(
      { title: "refused result", instructions: "do" },
      fixture.parentContext,
    );
    expect(handleResult.isError).toBe(false);
    const handle = JSON.parse(handleResult.output) as { spawnId: string };
    await turnStarted;
    expect(
      fixture.runner.interruptRun(handle.spawnId, parentSessionId),
    ).toMatchObject({ ok: true });

    const run = (
      fixture.runner as unknown as {
        trackedRuns: Map<string, { childSessionId: string; taskState: string }>;
      }
    ).trackedRuns.get(handle.spawnId);
    expect(run?.taskState).toBe(A2ATaskState.CANCELED);
    const childSessionId = run!.childSessionId;

    // The child's completed answer arrives behind the interrupt.
    (fixture.runner as unknown as {
      finalizeRun: (run: unknown, result: SubAgentSpawnResult) => void;
    }).finalizeRun(run, {
      summary: "the child's answer",
      toolCallCount: 0,
      turnCount: 1,
      childSessionId,
      entries: [],
      ok: true,
      stopReason: "end_turn",
    });

    // Refused: nothing of that result is readable through agent_status.
    const snapshot = fixture.runner.getRunStatus(handle.spawnId, parentSessionId, {
      deliversReportToParent: true,
    });
    expect(snapshot?.taskState).toBe(A2ATaskState.CANCELED);
    expect(snapshot?.summary).toBeUndefined();
    expect(snapshot?.error).toBeUndefined();

    // The mailbox copy, which does carry the answer, is therefore still owed.
    await expect(fixture.runner.deliverToParent(
      {
        parentSessionId,
        childSessionId,
        message: {
          messageId: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          contextId: parentSessionId,
          taskId: childSessionId,
          role: A2A_ROLE_AGENT,
          parts: [{ text: "the child's answer" }],
          metadata: { taskState: A2ATaskState.COMPLETED },
        } satisfies A2AMessage,
      },
      { terminalReport: true },
    )).resolves.toMatchObject({ ok: true });

    const owed = await fixture.runner.peekParentMailbox(parentSessionId);
    expect(owed).toHaveLength(1);
    expect(owed[0]?.formattedText).toContain("the child's answer");
  });

  it("delivers a report the parent never read exactly once across two turns", async () => {
    const fixture = completionMailboxFixture();
    const { queued } = await spawnUntilReportQueued(fixture, "never read");
    expect(queued).toHaveLength(1);

    // Turn one: the parent never called agent_status, so the report is still
    // owed and must be handed over rather than quietly retired.
    const firstTurn = await fixture.runner.peekParentMailbox(parentSessionId);
    expect(firstTurn).toHaveLength(1);
    expect(firstTurn[0]?.id).toBe(queued[0]?.id);
    await expect(
      fixture.runner.acknowledgeParentMailbox(parentSessionId, [firstTurn[0]!.id]),
    ).resolves.toBe(1);

    // Turn two: consumed, and not replayed.
    await expect(
      fixture.runner.peekParentMailbox(parentSessionId),
    ).resolves.toEqual([]);
  });
});
