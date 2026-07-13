import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { MemoryManager, type SessionMetadata } from "../../memory/memory-manager.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import { SubAgentRunner, type A2AWireHostBinding } from "../subagent-runner.js";
import type { TurnResult } from "../turn/types.js";

const COMPLETED_TURN: TurnResult = {
  text: "done",
  toolCalls: [],
  route: "default",
  stopReason: "end_turn",
};
const INPUT_REQUIRED_TURN: TurnResult = {
  text: "partial",
  toolCalls: [],
  route: "default",
  stopReason: "round-cap",
};

function buildLoopDeps(
  toolRegistry: ToolRegistry,
  getDefaultProject = vi.fn(() => ({
    projectRoot: "C:\\untrusted-default-project",
    projectName: "Untrusted Default",
  })),
) {
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
    keywordEngine: new KeywordEngine(),
    routeEngine: new RouteEngine({ toolRegistry }),
    toolRegistry,
    memoryManager: {
      saveSession: () => Promise.resolve(),
      listSessions: () => [],
    },
    getDefaultProject,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0];
}

function registerNoop(toolRegistry: ToolRegistry): void {
  toolRegistry.register(createDynamicTool({
    name: "noop",
    description: "No-op tool",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  }));
}

function makeResumeId(originSessionId: string): string {
  const tag = createHash("sha256").update(originSessionId).digest("hex").slice(0, 8);
  return "sub-" + tag + "-" + randomUUID();
}

describe("SubAgentRunner A2A wire security contract", () => {
  let tmpHome: string;
  let previousLvisHome: string | undefined;
  let store: MemoryManager;
  let toolRegistry: ToolRegistry;
  let loadSessionSpy: { mockRestore(): void };

  beforeEach(() => {
    previousLvisHome = process.env.LVIS_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "lvis-a2a-wire-runner-"));
    process.env.LVIS_HOME = tmpHome;
    store = new MemoryManager({ lvisDir: openFeatureNamespace("subagent").dir });
    store.load();
    toolRegistry = new ToolRegistry();
    registerNoop(toolRegistry);
    vi.spyOn(
      ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
      "hasProvider",
    ).mockReturnValue(true);
    loadSessionSpy = vi.spyOn(
      ConversationLoop.prototype as unknown as { loadSession: (id: string) => boolean },
      "loadSession",
    ).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = previousLvisHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeRunner(getDefaultProject?: ReturnType<typeof vi.fn>): SubAgentRunner {
    return new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry, getDefaultProject),
      toolRegistry,
      subAgentMemoryManager: store,
    });
  }

  function makeBinding(
    sourceTools: readonly string[] = ["noop"],
    handlerId = "wire-handler-a",
  ): A2AWireHostBinding {
    return {
      handlerId,
      profile: {
        name: "wire profile",
        body: "Follow the host profile.",
        sourceTools,
      },
      project: {
        root: join(tmpHome, "host-project"),
        name: "Host Project",
      },
    };
  }

  async function saveWaitingMetadata(
    resumeId: string,
    originSessionId: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await store.saveSessionMetadata(resumeId, {
      sessionKind: "subagent",
      sourceTools: ["noop"],
      originSessionId,
      projectRoot: join(tmpHome, "host-project"),
      subAgentTitle: "wire profile",
      budgetResumeCount: 0,
      questionAnswerCount: 0,
      resumeCount: 0,
      cumulativeRounds: 0,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "budget",
      ...extra,
    } as SessionMetadata);
  }

  function writeRawWaitingMetadata(
    resumeId: string,
    originSessionId: string,
    extra: Record<string, unknown>,
  ): void {
    writeFileSync(
      join(
        openFeatureNamespace("subagent").dir,
        "sessions",
        resumeId + ".meta.json",
      ),
      JSON.stringify({
        sessionKind: "subagent",
        sourceTools: ["noop"],
        originSessionId,
        projectRoot: join(tmpHome, "host-project"),
        subAgentTitle: "wire profile",
        budgetResumeCount: 0,
        questionAnswerCount: 0,
        resumeCount: 0,
        cumulativeRounds: 0,
        subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
        subAgentSuspensionReason: "budget",
        ...extra,
      }, null, 2),
      "utf8",
    );
  }

  it("fails closed before provider work when the required durable-link barrier is absent", async () => {
    const runner = makeRunner();
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);

    const result = await runner.spawnFromA2AWire(
      { messageText: "Do the work." },
      makeBinding(),
      undefined as never,
    );

    expect(result).toMatchObject({ ok: false, toolCallCount: 0, turnCount: 0 });
    expect(result.error).toMatch(/durable|A2A wire binding/i);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("orders durable metadata/link observers before the fixed wire provider provenance", async () => {
    const events: string[] = [];
    const binding = makeBinding();
    const originalSave = store.saveSessionMetadata.bind(store);
    let saveCount = 0;
    vi.spyOn(store, "saveSessionMetadata").mockImplementation(async (...args) => {
      saveCount += 1;
      if (saveCount === 1) events.push("metadata");
      await originalSave(...args);
    });
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockImplementation(async (
      _prompt,
      _callbacks,
      _abortSignal,
      options,
    ) => {
      expect(options).toMatchObject({
        inputOrigin: "agent-message",
        approvalReasonPrefix: "[A2A Wire]",
        spawnDepth: 1,
      });
      events.push("provider");
      return COMPLETED_TURN;
    });
    const runner = makeRunner();

    const result = await runner.spawnFromA2AWire(
      { messageText: "Do the work." },
      binding,
      {
        onDurablyLinked: async ({ childSessionId }) => {
          expect(store.loadSessionMetadata(childSessionId)).toMatchObject({
            subAgentTaskState: "TASK_STATE_SUBMITTED",
            a2aWireHandlerId: binding.handlerId,
            projectRoot: binding.project.root,
          });
          events.push("barrier");
        },
        onLinked: () => { events.push("linked"); },
      },
    );

    expect(result.ok).toBe(true);
    expect(events.slice(0, 4)).toEqual(["metadata", "barrier", "linked", "provider"]);
  });

  it("keeps onLinked and provider work behind a rejecting durable-link barrier", async () => {
    const onLinked = vi.fn();
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();

    const result = await runner.spawnFromA2AWire(
      { messageText: "Do the work." },
      makeBinding(),
      {
        onDurablyLinked: async () => { throw new Error("Task binding write failed"); },
        onLinked,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      toolCallCount: 0,
      turnCount: 0,
      error: "sub-agent durable binding failed",
    });
    expect(onLinked).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("uses only the host-frozen project even when the wire request carries project-shaped fields", async () => {
    const getDefaultProject = vi.fn(() => ({
      projectRoot: join(tmpHome, "default-project"),
      projectName: "Default Project",
    }));
    const originalNewConversation = ConversationLoop.prototype.newConversation;
    const newConversation = vi.spyOn(ConversationLoop.prototype, "newConversation")
      .mockImplementation(function (
        this: ConversationLoop,
        ...args: Parameters<typeof originalNewConversation>
      ) {
        return originalNewConversation.apply(this, args);
      });
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner(getDefaultProject);
    const binding = makeBinding();

    const result = await runner.spawnFromA2AWire(
      {
        messageText: "Do the work.",
        projectRoot: join(tmpHome, "wire-selected-project"),
        projectName: "Wire Selected",
      } as never,
      binding,
      { onDurablyLinked: async () => undefined },
    );

    expect(result.ok).toBe(true);
    expect(newConversation).toHaveBeenCalledWith("subagent", {
      projectRoot: binding.project.root,
      projectName: binding.project.name,
    });
    expect(getDefaultProject).not.toHaveBeenCalled();
  });

  it("refuses the regular resume entry point for fully wire-bound metadata", async () => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    await saveWaitingMetadata(resumeId, originSessionId, {
      a2aWireHandlerId: "wire-handler-a",
      a2aWireInternalOrigin: originSessionId,
    });
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();

    const result = await runner.resume(
      resumeId,
      "continue",
      "wire profile",
      undefined,
      originSessionId,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/wire-bound task requires the A2A wire entry point/i);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["handler", "wire-handler-b", "wire-origin-handler-a"],
    ["internal origin", "wire-handler-a", "wire-origin-handler-b"],
  ])("fails closed before provider work on a mismatched %s", async (
    _field,
    callerHandlerId,
    storedInternalOrigin,
  ) => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    const bindingMetadata = {
      a2aWireHandlerId: "wire-handler-a",
      a2aWireInternalOrigin: storedInternalOrigin,
    };
    if (storedInternalOrigin === originSessionId) {
      await saveWaitingMetadata(resumeId, originSessionId, bindingMetadata);
    } else {
      writeRawWaitingMetadata(resumeId, originSessionId, bindingMetadata);
    }
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();

    const result = await runner.resumeFromA2AWire(
      { resumeId, messageText: "continue" },
      { handlerId: callerHandlerId },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/A2A wire(?: resume)? binding/i);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("preserves an explicit empty tool scope across INPUT_REQUIRED and wire resume", async () => {
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValueOnce(INPUT_REQUIRED_TURN)
      .mockResolvedValueOnce(COMPLETED_TURN);
    const runner = makeRunner();
    const binding = makeBinding([]);

    const waiting = await runner.spawnFromA2AWire(
      { messageText: "Start the work." },
      binding,
      { onDurablyLinked: async () => undefined },
    );

    expect(waiting).toMatchObject({
      ok: true,
      stopReason: "round-cap",
      suspension: { reason: "budget" },
    });
    expect(store.loadSessionMetadata(waiting.childSessionId)).toMatchObject({
      sourceTools: [],
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      a2aWireHandlerId: binding.handlerId,
    });

    vi.spyOn(ConversationLoop.prototype, "getSessionProjectRoot")
      .mockReturnValue(binding.project.root);
    const completed = await runner.resumeFromA2AWire(
      { resumeId: waiting.childSessionId, messageText: "continue" },
      { handlerId: binding.handlerId },
    );

    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["partial handler", (_origin: string) => ({ a2aWireHandlerId: "wire-handler-a" })],
    ["partial internal origin", (origin: string) => ({ a2aWireInternalOrigin: origin })],
    ["malformed handler", () => ({ a2aWireHandlerId: "wire handler with spaces" })],
    ["malformed internal origin", () => ({ a2aWireInternalOrigin: "wire origin with spaces" })],
    ["valid handler plus malformed origin", () => ({
      a2aWireHandlerId: "wire-handler-a",
      a2aWireInternalOrigin: "wire origin with spaces",
    })],
  ])("does not downgrade %s metadata into a regular resumable task", async (
    _caseName,
    buildBindingFields,
  ) => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    writeRawWaitingMetadata(
      resumeId,
      originSessionId,
      buildBindingFields(originSessionId),
    );
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();

    const result = await runner.resume(
      resumeId,
      "continue",
      "wire profile",
      undefined,
      originSessionId,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/metadata|wire-bound|A2A wire binding/i);
    expect(runTurn).not.toHaveBeenCalled();
  });
  it.each(["onLinked", "onActivity", "onError"] as const)(
    "rejects malformed optional %s callbacks with a structured provider-zero result",
    async (field) => {
      const barrier = vi.fn(async () => undefined);
      const callbacks: Record<string, unknown> = { onDurablyLinked: barrier };
      callbacks[field] = "not-a-function";
      const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
        .mockResolvedValue(COMPLETED_TURN);
      const runner = makeRunner();

      const result = await runner.spawnFromA2AWire(
        { messageText: "Do the work." },
        makeBinding(),
        callbacks as never,
      );

      expect(result).toMatchObject({
        ok: false,
        error: "sub-agent A2A wire binding is invalid",
        toolCallCount: 0,
        turnCount: 0,
        entries: [],
        childSessionId: expect.any(String),
      });
      expect(barrier).not.toHaveBeenCalled();
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["throws", "rejects"] as const)(
    "isolates an onLinked observer that %s after the durable barrier",
    async (behavior) => {
      const events: string[] = [];
      const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
        .mockImplementation(async () => {
          events.push("provider");
          return COMPLETED_TURN;
        });
      const onLinked = behavior === "throws"
        ? () => {
            events.push("linked");
            throw new Error("observer failed");
          }
        : async () => {
            events.push("linked");
            throw new Error("observer rejected");
          };
      const runner = makeRunner();

      const result = await runner.spawnFromA2AWire(
        { messageText: "Do the work." },
        makeBinding(),
        {
          onDurablyLinked: async () => { events.push("barrier"); },
          onLinked,
        },
      );
      await Promise.resolve();

      expect(result).toMatchObject({ ok: true, stopReason: "end_turn" });
      expect(events).toEqual(["barrier", "linked", "provider"]);
      expect(runTurn).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["profile.model", "profile.mode", "project.name"] as const)(
    "rejects malformed optional %s before provider work",
    async (field) => {
      const binding = makeBinding();
      if (field === "profile.model") {
        (binding.profile as { model?: unknown }).model = 42;
      } else if (field === "profile.mode") {
        (binding.profile as { mode?: unknown }).mode = null;
      } else {
        (binding.project as { name?: unknown }).name = ["invalid"];
      }
      const barrier = vi.fn(async () => undefined);
      const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
        .mockResolvedValue(COMPLETED_TURN);
      const runner = makeRunner();

      const result = await runner.spawnFromA2AWire(
        { messageText: "Do the work." },
        binding,
        { onDurablyLinked: barrier },
      );

      expect(result).toMatchObject({
        ok: false,
        error: "sub-agent A2A wire binding is invalid",
        toolCallCount: 0,
        turnCount: 0,
      });
      expect(barrier).not.toHaveBeenCalled();
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it("fails provider-zero when spawn project authorization falls back to another root", async () => {
    const binding = makeBinding();
    const fallbackRoot = join(tmpHome, "fallback-project");
    const authorizeProject = vi.fn(() => null);
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      authorizeProject,
      getDefaultProject: () => ({
        projectRoot: fallbackRoot,
        projectName: "Fallback Project",
        isDefault: true,
      }),
      isDefaultProjectRoot: (root: string) => root === fallbackRoot,
    };
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: store,
    });
    const barrier = vi.fn(async () => undefined);
    const onLinked = vi.fn();
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);

    const result = await runner.spawnFromA2AWire(
      { messageText: "Do the work." },
      binding,
      { onDurablyLinked: barrier, onLinked },
    );

    expect(authorizeProject).toHaveBeenCalledWith(
      binding.project.root,
      binding.project.name,
    );
    expect(result).toMatchObject({
      ok: false,
      error: "sub-agent A2A project binding rejected (a2a-project-binding-rejected)",
      toolCallCount: 0,
      turnCount: 0,
    });
    expect(barrier).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("fails provider-zero when a persisted project re-authorizes to another root on wire resume", async () => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    const hostRoot = join(tmpHome, "host-project");
    const fallbackRoot = join(tmpHome, "fallback-project");
    await store.saveSession(resumeId, [{ role: "user", content: "seed" }]);
    await saveWaitingMetadata(resumeId, originSessionId, {
      a2aWireHandlerId: "wire-handler-a",
      a2aWireInternalOrigin: originSessionId,
    });
    loadSessionSpy.mockRestore();
    const authorizeProject = vi.fn(() => null);
    const parentDeps = {
      ...buildLoopDeps(toolRegistry),
      authorizeProject,
      getDefaultProject: () => ({
        projectRoot: fallbackRoot,
        projectName: "Fallback Project",
        isDefault: true,
      }),
      isDefaultProjectRoot: (root: string) => root === fallbackRoot,
    };
    const runner = new SubAgentRunner({
      parentDeps,
      toolRegistry,
      subAgentMemoryManager: store,
    });
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);

    const result = await runner.resumeFromA2AWire(
      { resumeId, messageText: "continue" },
      { handlerId: "wire-handler-a" },
    );

    expect(authorizeProject).toHaveBeenCalledWith(hostRoot, undefined);
    expect(result).toMatchObject({
      ok: false,
      error: "sub-agent resume: A2A project binding rejected (a2a-project-binding-rejected)",
      toolCallCount: 0,
      turnCount: 0,
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

});
