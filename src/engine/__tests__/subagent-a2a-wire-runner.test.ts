import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputClassifier } from "../../core/input-classifier.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import { createDlpSafeUuid } from "../../shared/dlp-safe-id.js";
import { RouteEngine } from "../../core/route-engine.js";
import { MemoryManager, type SessionMetadata,
} from "../../memory/memory-manager.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import {
  SubAgentRunner,
  type A2AWireHostBinding,
  type SubAgentSpawnResult,
} from "../subagent-runner.js";
import type { TurnResult } from "../turn/types.js";

vi.mock("../../observability/conversation-trace.js", () => ({
  createTracer: () => ({
    enabled: false,
    step: () => undefined,
  }),
}));

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
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
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
  }),
  );
}

function makeResumeId(originSessionId: string): string {
  const tag = createHash("sha256").update(originSessionId).digest("hex").slice(0, 8);
  return createDlpSafeUuid(`sub-${tag}`);
}

describe("SubAgentRunner A2A wire security contract", () => {
  let tmpHome: string;
  let store: MemoryManager;
  let toolRegistry: ToolRegistry;
  let loadSessionSpy: { mockRestore(): void };

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "lvis-a2a-wire-runner-"));
    store = new MemoryManager({ lvisDir: join(tmpHome, "subagent") });
    store.load();
    toolRegistry = new ToolRegistry();
    registerNoop(toolRegistry);
    vi.spyOn(
      ConversationLoop.prototype as unknown as { hasProvider: () => boolean },
      "hasProvider",
    ).mockReturnValue(true);
    loadSessionSpy = vi
      .spyOn(
        ConversationLoop.prototype as unknown as {
          loadSession: (id: string) => boolean;
        },
        "loadSession",
      )
      .mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeRunner(
    getDefaultProject?: ReturnType<typeof vi.fn>,
  ): SubAgentRunner {
    return new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry, getDefaultProject),
      toolRegistry,
      subAgentMemoryManager: store,
    });
  }

  function pauseQuestionStagePreparation(runner: SubAgentRunner): {
    entered: Promise<void>;
    release: () => void;
  } {
    type PreparationTarget = {
      prepareQuestionStageForPersistence: (
        questionWait: unknown,
        result: SubAgentSpawnResult,
      ) => Promise<SubAgentSpawnResult>;
    };
    const target = runner as unknown as PreparationTarget;
    const original = target.prepareQuestionStageForPersistence.bind(runner);
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(target, "prepareQuestionStageForPersistence").mockImplementation(
      async (questionWait, result) => {
        signalEntered();
        await gate;
        return await original(questionWait, result);
      },
    );
    return { entered, release };
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

  function makeNonCanonicalProjectRoot(): string {
    return `${join(tmpHome, "project-parent")}${sep}..${sep}host-project`;
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
      subAgentSuspensionPrompt: "Continue the task.",
      ...extra,
    } as SessionMetadata);
  }

  function writeRawWaitingMetadata(
    resumeId: string,
    originSessionId: string,
    extra: Record<string, unknown>,
  ): void {
    writeFileSync(
      join(join(tmpHome, "subagent"), "sessions", resumeId + ".meta.json"),
      JSON.stringify(
        {
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
          subAgentSuspensionPrompt: "Continue the task.",
          ...extra,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  it("fails closed before provider work when the required durable-link barrier is absent", async () => {
    const runner = makeRunner();
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
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
    vi.spyOn(store, "saveSessionMetadata").mockImplementation(
      async (...args) => {
        saveCount += 1;
        if (saveCount === 1) events.push("metadata");
        await originalSave(...args);
      },
    );
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockImplementation(
      async (_prompt, _callbacks, _abortSignal, options) => {
        expect(options).toMatchObject({
          inputOrigin: "agent-message",
          approvalReasonPrefix: "[A2A Wire]",
          spawnDepth: 1,
        });
        events.push("provider");
        return COMPLETED_TURN;
      },
    );
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
        onLinked: () => {
          events.push("linked");
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(maskSensitiveData(result.childSessionId).detections).toEqual([]);
    const metadata = store.loadSessionMetadata(result.childSessionId);
    expect(metadata?.a2aWireInternalOrigin).toMatch(/^a2a-wire-[0-9a-f]{8}-/);
    expect(
      maskSensitiveData(metadata?.a2aWireInternalOrigin ?? "").detections,
    ).toEqual([]);
    expect(events.slice(0, 4)).toEqual([
      "metadata",
      "barrier",
      "linked",
      "provider",
    ]);
  });

  it("keeps onLinked and provider work behind a rejecting durable-link barrier", async () => {
    const onLinked = vi.fn();
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();

    const result = await runner.spawnFromA2AWire(
      { messageText: "Do the work." },
      makeBinding(),
      {
        onDurablyLinked: async () => {
          throw new Error("Task binding write failed");
        },
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
    expect(
      (runner as unknown as { activeChildren: Map<string, unknown> })
        .activeChildren.size,
    ).toBe(0);
  });

  it("fails closed before durable linking when the initial metadata save is tombstoned", async () => {
    const binding = makeBinding();
    const originalSave = store.saveSessionMetadata.bind(store);
    let signalInitialSave!: () => void;
    const initialSaveEntered = new Promise<void>((resolve) => {
      signalInitialSave = resolve;
    });
    let releaseInitialSave!: () => void;
    const initialSaveGate = new Promise<void>((resolve) => {
      releaseInitialSave = resolve;
    });
    let firstSave = true;
    vi.spyOn(store, "saveSessionMetadata").mockImplementation(
      async (...args) => {
        if (firstSave) {
          firstSave = false;
          signalInitialSave();
          await initialSaveGate;
        }
        await originalSave(...args);
      },
    );
    const onDurablyLinked = vi.fn(async () => undefined);
    const onLinked = vi.fn();
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();
    const running = runner.spawnFromA2AWire(
      { messageText: "Do the work." },
      binding,
      { onDurablyLinked, onLinked },
    );
    await initialSaveEntered;

    // Bypass the runner-level live cancellation to isolate the authoritative
    // post-save revalidation. The root tombstone transforms the pending write.
    await expect(
      store.detachSessionsFromProject(binding.project.root),
    ).resolves.toBe(0);
    releaseInitialSave();

    await expect(running).resolves.toMatchObject({
      ok: false,
      stopReason: "interrupted",
    });
    expect(onDurablyLinked).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
    expect(
      (runner as unknown as { activeChildren: Map<string, unknown> })
        .activeChildren.size,
    ).toBe(0);
  });

  it("fails closed before provider work when a resume WORKING save is tombstoned", async () => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    const binding = makeBinding();
    await saveWaitingMetadata(resumeId, originSessionId, {
      a2aWireHandlerId: binding.handlerId,
      a2aWireInternalOrigin: originSessionId,
    });
    vi.spyOn(
      ConversationLoop.prototype,
      "getSessionProjectRoot",
    ).mockReturnValue(binding.project.root);
    const originalSave = store.saveSessionMetadata.bind(store);
    let signalWorkingSave!: () => void;
    const workingSaveEntered = new Promise<void>((resolve) => {
      signalWorkingSave = resolve;
    });
    let releaseWorkingSave!: () => void;
    const workingSaveGate = new Promise<void>((resolve) => {
      releaseWorkingSave = resolve;
    });
    let heldWorkingSave = false;
    vi.spyOn(store, "saveSessionMetadata").mockImplementation(
      async (...args) => {
        const metadata = args[1];
        if (
          !heldWorkingSave &&
          metadata.subAgentTaskState === "TASK_STATE_WORKING"
        ) {
          heldWorkingSave = true;
          signalWorkingSave();
          await workingSaveGate;
        }
        await originalSave(...args);
      },
    );
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();
    const running = runner.resumeFromA2AWire(
      { resumeId, messageText: "continue" },
      { handlerId: binding.handlerId },
    );
    await workingSaveEntered;

    // As above, isolate the post-WORKING-save reload from runner-level abort.
    await expect(
      store.detachSessionsFromProject(binding.project.root),
    ).resolves.toBe(1);
    releaseWorkingSave();

    await expect(running).resolves.toMatchObject({
      ok: false,
      stopReason: "interrupted",
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(
      (runner as unknown as { activeChildren: Map<string, unknown> })
        .activeChildren.size,
    ).toBe(0);
    expect(store.loadSessionMetadata(resumeId)).toMatchObject({
      projectRoot: undefined,
      subAgentTaskState: "TASK_STATE_CANCELED",
    });
  });

  it("cancels a wire spawn when its project is removed during the durable barrier", async () => {
    let releaseBarrier!: () => void;
    const barrierGate = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let linkedChildSessionId = "";
    const barrier = vi.fn(
      async ({ childSessionId }: { childSessionId: string }) => {
        linkedChildSessionId = childSessionId;
        await barrierGate;
      },
    );
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();
    const binding = makeBinding();
    binding.project.root = makeNonCanonicalProjectRoot();
    const running = runner.spawnFromA2AWire(
      { messageText: "Do the work." },
      binding,
      { onDurablyLinked: barrier },
    );
    await vi.waitFor(() => expect(barrier).toHaveBeenCalledTimes(1));

    await expect(
      runner.detachSessionsFromProject(binding.project.root),
    ).resolves.toBe(1);
    expect(
      runner.getA2AWireRunSnapshot(linkedChildSessionId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_CANCELED" });
    releaseBarrier();

    await expect(running).resolves.toMatchObject({
      ok: false,
      stopReason: "interrupted",
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(
      (runner as unknown as { activeChildren: Map<string, unknown> })
        .activeChildren.size,
    ).toBe(0);
    expect(store.loadSessionMetadata(linkedChildSessionId)).toMatchObject({
      projectRoot: undefined,
      a2aWireHandlerId: binding.handlerId,
      subAgentTaskState: "TASK_STATE_CANCELED",
    });
    expect(
      runner.getA2AWireRunSnapshot(linkedChildSessionId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_CANCELED" });
  });

  it("cancels a wire resume when its project is removed during mailbox I/O", async () => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    const binding = makeBinding();
    binding.project.root = makeNonCanonicalProjectRoot();
    await saveWaitingMetadata(resumeId, originSessionId, {
      projectRoot: binding.project.root,
      a2aWireHandlerId: binding.handlerId,
      a2aWireInternalOrigin: originSessionId,
    });
    let signalMailboxEntered!: () => void;
    const mailboxEntered = new Promise<void>((resolve) => {
      signalMailboxEntered = resolve;
    });
    let releaseMailbox!: () => void;
    const mailboxGate = new Promise<void>((resolve) => {
      releaseMailbox = resolve;
    });
    const peekRecipientMailbox = vi.fn(async () => {
      signalMailboxEntered();
      await mailboxGate;
      return [];
    });
    vi.spyOn(
      ConversationLoop.prototype,
      "getSessionProjectRoot",
    ).mockReturnValue(binding.project.root);
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: store,
      agentMessageBus: { peekRecipientMailbox } as never,
    });
    const running = runner.resumeFromA2AWire(
      { resumeId, messageText: "continue" },
      { handlerId: binding.handlerId },
    );
    await mailboxEntered;

    await expect(
      runner.detachSessionsFromProject(binding.project.root),
    ).resolves.toBe(1);
    expect(
      runner.getA2AWireRunSnapshot(resumeId, { handlerId: binding.handlerId }),
    ).toMatchObject({ taskState: "TASK_STATE_CANCELED" });
    releaseMailbox();

    await expect(running).resolves.toMatchObject({
      ok: false,
      stopReason: "interrupted",
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(
      (runner as unknown as { activeChildren: Map<string, unknown> })
        .activeChildren.size,
    ).toBe(0);
    expect(store.loadSessionMetadata(resumeId)).toMatchObject({
      projectRoot: undefined,
      a2aWireHandlerId: binding.handlerId,
      subAgentTaskState: "TASK_STATE_CANCELED",
    });
    expect(
      runner.getA2AWireRunSnapshot(resumeId, { handlerId: binding.handlerId }),
    ).toMatchObject({ taskState: "TASK_STATE_CANCELED" });
  });

  it("uses only the host-frozen project even when the wire request carries project-shaped fields", async () => {
    const getDefaultProject = vi.fn(() => ({
      projectRoot: join(tmpHome, "default-project"),
      projectName: "Default Project",
    }));
    const originalNewConversation = ConversationLoop.prototype.newConversation;
    const newConversation = vi
      .spyOn(ConversationLoop.prototype, "newConversation")
      .mockImplementation(function (
        this: ConversationLoop,
        ...args: Parameters<typeof originalNewConversation>
      ) {
        return originalNewConversation.apply(this, args);
      });
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockResolvedValue(
      COMPLETED_TURN,
    );
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
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
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
    expect(result.error).toMatch(
      /wire-bound task requires the A2A wire entry point/i,
    );
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("keeps a detached wire task observable but refuses both resume entry points", async () => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    const binding = makeBinding();
    await saveWaitingMetadata(resumeId, originSessionId, {
      a2aWireHandlerId: binding.handlerId,
      a2aWireInternalOrigin: originSessionId,
    });
    await expect(
      store.detachSessionsFromProject(binding.project.root),
    ).resolves.toBe(1);
    expect(store.loadSessionMetadata(resumeId)).toMatchObject({
      projectRoot: undefined,
      a2aWireHandlerId: binding.handlerId,
      a2aWireInternalOrigin: originSessionId,
      subAgentTaskState: "TASK_STATE_CANCELED",
    });

    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const wireRunner = makeRunner();
    expect(
      wireRunner.getA2AWireRunSnapshot(resumeId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_CANCELED" });
    const wireResult = await wireRunner.resumeFromA2AWire(
      { resumeId, messageText: "continue" },
      { handlerId: binding.handlerId },
    );
    const regularResult = await makeRunner().resume(
      resumeId,
      "continue",
      "wire profile",
      undefined,
      originSessionId,
    );

    expect(wireResult.ok).toBe(false);
    expect(regularResult.ok).toBe(false);
    expect(runTurn).not.toHaveBeenCalled();

    store.allowProjectRoot(binding.project.root);
    expect(
      wireRunner.getA2AWireRunSnapshot(resumeId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_CANCELED" });
  });

  it.each([
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_REJECTED",
  ] as const)("keeps a detached %s wire task observable", async (taskState) => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    const binding = makeBinding();
    await saveWaitingMetadata(resumeId, originSessionId, {
      projectRoot: undefined,
      projectName: undefined,
      a2aWireHandlerId: binding.handlerId,
      a2aWireInternalOrigin: originSessionId,
      subAgentTaskState: taskState,
      subAgentSuspensionReason: undefined,
      subAgentSuspensionPrompt: undefined,
    });
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();

    expect(
      runner.getA2AWireRunSnapshot(resumeId, { handlerId: binding.handlerId }),
    ).toMatchObject({ taskState });
    await expect(
      runner.resumeFromA2AWire(
        { resumeId, messageText: "continue" },
        { handlerId: binding.handlerId },
      ),
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["handler", "wire-handler-b", "wire-origin-handler-a"],
    ["internal origin", "wire-handler-a", "wire-origin-handler-b"],
  ])(
    "fails closed before provider work on a mismatched %s",
    async (_field, callerHandlerId, storedInternalOrigin) => {
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
      const runTurn = vi
        .spyOn(ConversationLoop.prototype, "runTurn")
        .mockResolvedValue(COMPLETED_TURN);
      const runner = makeRunner();

      const result = await runner.resumeFromA2AWire(
        { resumeId, messageText: "continue" },
        { handlerId: callerHandlerId },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/A2A wire(?: resume)? binding/i);
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit empty tool scope across INPUT_REQUIRED and wire resume", async () => {
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
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

    vi.spyOn(
      ConversationLoop.prototype,
      "getSessionProjectRoot",
    ).mockReturnValue(binding.project.root);
    const completed = await runner.resumeFromA2AWire(
      { resumeId: waiting.childSessionId, messageText: "continue" },
      { handlerId: binding.handlerId },
    );

    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "partial handler",
      (_origin: string) => ({ a2aWireHandlerId: "wire-handler-a" }),
    ],
    [
      "partial internal origin",
      (origin: string) => ({ a2aWireInternalOrigin: origin }),
    ],
    [
      "malformed handler",
      () => ({ a2aWireHandlerId: "wire handler with spaces" }),
    ],
    [
      "malformed internal origin",
      () => ({ a2aWireInternalOrigin: "wire origin with spaces" }),
    ],
    [
      "valid handler plus malformed origin",
      () => ({
        a2aWireHandlerId: "wire-handler-a",
        a2aWireInternalOrigin: "wire origin with spaces",
      }),
    ],
  ])(
    "does not downgrade %s metadata into a regular resumable task",
    async (_caseName, buildBindingFields) => {
      const originSessionId = "wire-origin-handler-a";
      const resumeId = makeResumeId(originSessionId);
      writeRawWaitingMetadata(
        resumeId,
        originSessionId,
        buildBindingFields(originSessionId),
      );
      const runTurn = vi
        .spyOn(ConversationLoop.prototype, "runTurn")
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
    },
  );
  it.each(["onLinked", "onActivity", "onError"] as const)(
    "rejects malformed optional %s callbacks with a structured provider-zero result",
    async (field) => {
      const barrier = vi.fn(async () => undefined);
      const callbacks: Record<string, unknown> = { onDurablyLinked: barrier };
      callbacks[field] = "not-a-function";
      const runTurn = vi
        .spyOn(ConversationLoop.prototype, "runTurn")
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
      const runTurn = vi
        .spyOn(ConversationLoop.prototype, "runTurn")
        .mockImplementation(async () => {
          events.push("provider");
          return COMPLETED_TURN;
        });
      const onLinked =
        behavior === "throws"
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
          onDurablyLinked: async () => {
            events.push("barrier");
          },
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
      const runTurn = vi
        .spyOn(ConversationLoop.prototype, "runTurn")
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
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
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
      error:
        "sub-agent A2A project binding rejected (a2a-project-binding-rejected)",
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
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);

    const result = await runner.resumeFromA2AWire(
      { resumeId, messageText: "continue" },
      { handlerId: "wire-handler-a" },
    );

    expect(authorizeProject).toHaveBeenCalledWith(hostRoot, undefined);
    expect(result).toMatchObject({
      ok: false,
      error:
        "sub-agent resume: A2A project binding rejected (a2a-project-binding-rejected)",
      toolCallCount: 0,
      turnCount: 0,
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("projects and cancels a persisted wire wait only for its bound handler", async () => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    await saveWaitingMetadata(resumeId, originSessionId, {
      a2aWireHandlerId: "wire-handler-a",
      a2aWireInternalOrigin: originSessionId,
      subAgentSuspensionPrompt: "Continue the task.",
    });
    const runner = makeRunner();

    expect(
      runner.getA2AWireRunSnapshot(resumeId, { handlerId: "wire-handler-b" }),
    ).toBeNull();
    expect(
      runner.getA2AWireRunSnapshot(resumeId, { handlerId: "wire-handler-a" }),
    ).toMatchObject({
      childSessionId: resumeId,
      taskState: "TASK_STATE_INPUT_REQUIRED",
      suspension: {
        reason: "budget",
        prompt: "Continue the task.",
        resumeId,
      },
    });

    await expect(
      runner.cancelA2AWireRun(resumeId, { handlerId: "wire-handler-b" }),
    ).resolves.toEqual({ ok: false, reason: "task-not-found" });
    await expect(
      runner.cancelA2AWireRun(resumeId, { handlerId: "wire-handler-a" }),
    ).resolves.toMatchObject({
      ok: true,
      run: { taskState: "TASK_STATE_CANCELED" },
    });
    expect(store.loadSessionMetadata(resumeId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_CANCELED",
    });
    await expect(
      runner.cancelA2AWireRun(resumeId, { handlerId: "wire-handler-a" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "task-not-cancelable",
    });
  });

  it("rejects an INPUT_REQUIRED wire binding without its typed prompt", async () => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    writeRawWaitingMetadata(resumeId, originSessionId, {
      a2aWireHandlerId: "wire-handler-a",
      a2aWireInternalOrigin: originSessionId,
      subAgentSuspensionPrompt: undefined,
    });
    const runTurn = vi
      .spyOn(ConversationLoop.prototype, "runTurn")
      .mockResolvedValue(COMPLETED_TURN);
    const runner = makeRunner();

    expect(
      runner.getA2AWireRunSnapshot(resumeId, { handlerId: "wire-handler-a" }),
    ).toBeNull();
    await expect(
      runner.resumeFromA2AWire(
        { resumeId, messageText: "continue" },
        { handlerId: "wire-handler-a" },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/wire resume binding is invalid/i),
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("cancels an active wire spawn without allowing a terminal regression", async () => {
    let enterTurn!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterTurn = resolve;
    });
    let finishTurn!: (result: TurnResult) => void;
    const turn = new Promise<TurnResult>((resolve) => {
      finishTurn = resolve;
    });
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockImplementation(
      async () => {
        enterTurn();
        return await turn;
      },
    );
    const runner = makeRunner();
    const binding = makeBinding();
    let childSessionId = "";
    const running = runner.spawnFromA2AWire(
      { messageText: "Start the work." },
      binding,
      {
        onDurablyLinked: async (link) => {
          childSessionId = link.childSessionId;
        },
      },
    );
    await entered;

    expect(
      runner.getA2AWireRunSnapshot(childSessionId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_WORKING" });
    await expect(
      runner.cancelA2AWireRun(childSessionId, { handlerId: binding.handlerId }),
    ).resolves.toMatchObject({
      ok: true,
      run: { taskState: "TASK_STATE_CANCELED" },
    });
    expect(store.loadSessionMetadata(childSessionId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_CANCELED",
    });

    finishTurn(COMPLETED_TURN);
    await expect(running).resolves.toMatchObject({
      ok: false,
      stopReason: "interrupted",
    });
    expect(
      runner.getA2AWireRunSnapshot(childSessionId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_CANCELED" });
  });

  it("keeps a durably waiting run cancelable and cleans its terminal mailbox", async () => {
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockResolvedValue(
      INPUT_REQUIRED_TURN,
    );
    const cleanupTerminalRecipientMailbox = vi.fn(async () => ({
      ok: true as const,
    }));
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: store,
      agentMessageBus: { cleanupTerminalRecipientMailbox } as never,
    });
    const binding = makeBinding();
    const waiting = await runner.spawnFromA2AWire(
      { messageText: "Start the work." },
      binding,
      { onDurablyLinked: async () => undefined },
    );
    expect(waiting).toMatchObject({
      ok: true,
      suspension: { reason: "budget" },
    });

    await expect(
      runner.cancelA2AWireRun(waiting.childSessionId, {
        handlerId: binding.handlerId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      run: { taskState: "TASK_STATE_CANCELED" },
    });
    expect(store.loadSessionMetadata(waiting.childSessionId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_CANCELED",
    });
    expect(cleanupTerminalRecipientMailbox).toHaveBeenCalledOnce();
  });

  it("retries owned cancellation persistence after provider finalization wins the latch", async () => {
    let enterTurn!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterTurn = resolve;
    });
    let finishTurn!: (result: TurnResult) => void;
    const turn = new Promise<TurnResult>((resolve) => {
      finishTurn = resolve;
    });
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockImplementation(
      async () => {
        enterTurn();
        return await turn;
      },
    );
    const originalSave = store.saveSessionMetadata.bind(store);
    let canceledSaveAttempts = 0;
    vi.spyOn(store, "saveSessionMetadata").mockImplementation(
      async (...args) => {
        if (args[1].subAgentTaskState === "TASK_STATE_CANCELED") {
          canceledSaveAttempts += 1;
          if (canceledSaveAttempts <= 2)
            throw new Error("simulated canceled metadata failure");
        }
        await originalSave(...args);
      },
    );
    const cleanupTerminalRecipientMailbox = vi.fn(async () => ({
      ok: true as const,
    }));
    const runner = new SubAgentRunner({
      parentDeps: buildLoopDeps(toolRegistry),
      toolRegistry,
      subAgentMemoryManager: store,
      agentMessageBus: { cleanupTerminalRecipientMailbox } as never,
    });
    const binding = makeBinding();
    let childSessionId = "";
    const running = runner.spawnFromA2AWire(
      { messageText: "Start the work." },
      binding,
      {
        onDurablyLinked: async (link) => {
          childSessionId = link.childSessionId;
        },
      },
    );
    await entered;

    await expect(
      runner.cancelA2AWireRun(childSessionId, { handlerId: binding.handlerId }),
    ).resolves.toEqual({ ok: false, reason: "storage-failed" });
    expect(store.loadSessionMetadata(childSessionId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_SUBMITTED",
    });
    expect(
      runner.getA2AWireRunSnapshot(childSessionId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_SUBMITTED" });

    finishTurn(COMPLETED_TURN);
    await expect(running).resolves.toMatchObject({
      ok: false,
      stopReason: "interrupted",
    });
    expect(store.loadSessionMetadata(childSessionId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_SUBMITTED",
    });
    expect(
      runner.getA2AWireRunSnapshot(childSessionId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_SUBMITTED" });

    await expect(
      runner.cancelA2AWireRun(childSessionId, { handlerId: binding.handlerId }),
    ).resolves.toMatchObject({
      ok: true,
      run: { taskState: "TASK_STATE_CANCELED" },
    });
    expect(canceledSaveAttempts).toBe(3);
    expect(store.loadSessionMetadata(childSessionId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_CANCELED",
    });
    expect(
      runner.getA2AWireRunSnapshot(childSessionId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_CANCELED" });
    expect(cleanupTerminalRecipientMailbox).toHaveBeenCalledOnce();
  });

  it("routes cancellation to the in-flight wire resume attempt", async () => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    const binding = makeBinding();
    await saveWaitingMetadata(resumeId, originSessionId, {
      a2aWireHandlerId: binding.handlerId,
      a2aWireInternalOrigin: originSessionId,
    });
    vi.spyOn(
      ConversationLoop.prototype,
      "getSessionProjectRoot",
    ).mockReturnValue(binding.project.root);
    let enterTurn!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterTurn = resolve;
    });
    let finishTurn!: (result: TurnResult) => void;
    const turn = new Promise<TurnResult>((resolve) => {
      finishTurn = resolve;
    });
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockImplementation(
      async () => {
        enterTurn();
        return await turn;
      },
    );
    const runner = makeRunner();
    const running = runner.resumeFromA2AWire(
      { resumeId, messageText: "continue" },
      { handlerId: binding.handlerId },
    );
    await entered;

    await expect(
      runner.cancelA2AWireRun(resumeId, { handlerId: binding.handlerId }),
    ).resolves.toMatchObject({
      ok: true,
      run: { taskState: "TASK_STATE_CANCELED" },
    });
    expect(store.loadSessionMetadata(resumeId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_CANCELED",
    });
    finishTurn(COMPLETED_TURN);
    await expect(running).resolves.toMatchObject({
      ok: false,
      stopReason: "interrupted",
    });
    expect(
      runner.getA2AWireRunSnapshot(resumeId, { handlerId: binding.handlerId }),
    ).toMatchObject({ taskState: "TASK_STATE_CANCELED" });
  });

  it("rejects spawn cancellation after terminal persistence ownership is claimed", async () => {
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockResolvedValue(
      COMPLETED_TURN,
    );
    const runner = makeRunner();
    const binding = makeBinding();
    const preparation = pauseQuestionStagePreparation(runner);
    let childSessionId = "";
    const running = runner.spawnFromA2AWire(
      { messageText: "Start the work." },
      binding,
      {
        onDurablyLinked: async (link) => {
          childSessionId = link.childSessionId;
        },
      },
    );
    await preparation.entered;

    const canceled = await runner.cancelA2AWireRun(childSessionId, {
      handlerId: binding.handlerId,
    });
    preparation.release();
    const result = await running;

    expect(canceled).toMatchObject({
      ok: false,
      reason: "task-not-cancelable",
    });
    expect(result).toMatchObject({
      ok: true,
      stopReason: "end_turn",
    });
    expect(store.loadSessionMetadata(childSessionId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_COMPLETED",
    });
    expect(
      runner.getA2AWireRunSnapshot(childSessionId, {
        handlerId: binding.handlerId,
      }),
    ).toMatchObject({ taskState: "TASK_STATE_COMPLETED" });
  });

  it("rejects resume cancellation after terminal persistence ownership is claimed", async () => {
    const originSessionId = "wire-origin-handler-a";
    const resumeId = makeResumeId(originSessionId);
    const binding = makeBinding();
    await saveWaitingMetadata(resumeId, originSessionId, {
      a2aWireHandlerId: binding.handlerId,
      a2aWireInternalOrigin: originSessionId,
    });
    vi.spyOn(
      ConversationLoop.prototype,
      "getSessionProjectRoot",
    ).mockReturnValue(binding.project.root);
    vi.spyOn(ConversationLoop.prototype, "runTurn").mockResolvedValue(
      COMPLETED_TURN,
    );
    const runner = makeRunner();
    const preparation = pauseQuestionStagePreparation(runner);
    const running = runner.resumeFromA2AWire(
      { resumeId, messageText: "continue" },
      { handlerId: binding.handlerId },
    );
    await preparation.entered;

    const canceled = await runner.cancelA2AWireRun(resumeId, {
      handlerId: binding.handlerId,
    });
    preparation.release();
    const result = await running;

    expect(canceled).toMatchObject({
      ok: false,
      reason: "task-not-cancelable",
    });
    expect(result).toMatchObject({
      ok: true,
      stopReason: "end_turn",
    });
    expect(store.loadSessionMetadata(resumeId)).toMatchObject({
      subAgentTaskState: "TASK_STATE_COMPLETED",
    });
    expect(
      runner.getA2AWireRunSnapshot(resumeId, { handlerId: binding.handlerId }),
    ).toMatchObject({ taskState: "TASK_STATE_COMPLETED" });
  });
});
