/**
 * B1 — Session resume + manual compact tests.
 *
 * Covers:
 * - resetAndResume clears streaming state (cumulativeUsage reset) and loads history
 * - resetAndResume triggers auto-compact when history exceeds threshold
 * - resetAndResume returns ok:false for unknown sessionId
 * - manualCompact returns compacted:true when history is long enough to compact
 * - manualCompact returns compacted:false when history is short
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import type { ConversationLoopDeps } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import { wireHookSystem } from "../../boot/steps/hook-system-wiring.js";
import { t } from "../../i18n/index.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  makeConversationLoopDeps,
  makeConversationLoopLongHistory,
  makeConversationLoopMemoryManager,
  makeConversationLoopSettings,
} from "./conversation-loop-test-helpers.js";

// ─── Minimal stubs ────────────────────────────────────────────────────────────

const RESUME_SESSION_ID = "08001f8f-a6f5-4bb9-820d-df1e8366af93";
const resumeMemory = (storedMessages: GenericMessage[] | null = null) =>
  makeConversationLoopMemoryManager(storedMessages, RESUME_SESSION_ID);
const resumeDeps = (overrides: Partial<ConversationLoopDeps> = {}) =>
  makeConversationLoopDeps({
    settingsService: makeConversationLoopSettings(true, "gpt-4o", "openai"),
    memoryManager: resumeMemory(),
    ...overrides,
  });

type CaptureExplicit = NonNullable<ConversationLoopDeps["memoryCaptureService"]>["captureExplicit"];

function createRememberCommandLoop(captureExplicit: CaptureExplicit, args = "retain this rollout preference") {
  const saveMemory = vi.fn();
  const memoryManager = {
    ...resumeMemory(),
    saveMemory,
  } as unknown as ConversationLoopDeps["memoryManager"];
  const routeEngine = {
    route: vi.fn().mockReturnValue({ route: "command", command: "remember", args }),
  } as unknown as ConversationLoopDeps["routeEngine"];
  const inputClassifier = {
    classify: vi.fn().mockReturnValue({ type: "command" }),
  } as unknown as ConversationLoopDeps["inputClassifier"];
  const memoryCaptureService: NonNullable<ConversationLoopDeps["memoryCaptureService"]> = { captureExplicit };
  const provider = {
    vendor: "openai" as const,
    streamTurn: async function* () { /* command route only */ },
  };
  const loop = new ConversationLoop(resumeDeps({ memoryManager, memoryCaptureService, routeEngine, inputClassifier }));
  (loop as unknown as { provider: typeof provider }).provider = provider;
  return {
    loop,
    saveMemory,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConversationLoop.resetAndResume", () => {
  it("refuses a session the host reports as held by another loop", () => {
    const mem = resumeMemory([{ role: "user", content: "hello" }]);
    const readSession = vi.spyOn(mem, "loadSession");
    const held = vi.fn((sessionId: string) => sessionId === RESUME_SESSION_ID);
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem, sessionHeldElsewhere: held }));

    // Both entry points — the IPC resume and the engine `/load` command.
    expect(loop.resetAndResume(RESUME_SESSION_ID).ok).toBe(false);
    expect(loop.loadSession(RESUME_SESSION_ID)).toBe(false);
    expect(readSession).not.toHaveBeenCalled();

    held.mockReturnValue(false);
    expect(loop.loadSession(RESUME_SESSION_ID)).toBe(true);
  });

  it("returns ok:false for unknown session", () => {
    const loop = new ConversationLoop(resumeDeps({ memoryManager: resumeMemory(null) }),
    );
    const result = loop.resetAndResume("afeff8fc-a07a-452d-8ab3-5457c56ee572");
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.compactedAt).toBeNull();
    expect(result.removedMessageCount).toBe(0);
  });

  it("loads history and resets cumulativeUsage", () => {
    const history: GenericMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const mem = resumeMemory(history);
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem }));

    // Simulate prior usage so we can confirm reset
    const result = loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93");

    expect(result.ok).toBe(true);
    expect(loop.getHistory().length).toBe(2);
    // Resume seeds token accounting from the exact persisted session history.
    expect(loop.getCumulativeUsage().inputTokens).toBe(estimateMessagesTokens(history),
    );
    expect(loop.getCumulativeUsage().outputTokens).toBe(0);
  });

  it("does NOT compact short history even with autoCompact enabled", () => {
    const history: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const mem = resumeMemory(history);
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem }));

    const result = loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93");

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.compactedAt).toBeNull();
    expect(result.removedMessageCount).toBe(0);
  });

  it("does NOT compact when autoCompact is disabled", () => {
    const history = makeConversationLoopLongHistory(20);
    const mem = resumeMemory(history);
    const settings = makeConversationLoopSettings(false, "gpt-4o", "openai");
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem, settingsService: settings }),
    );

    const result = loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93");

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
  });

  it("session-id is updated to the resumed session", () => {
    const history: GenericMessage[] = [{ role: "user", content: "resume me" }];
    const mem = resumeMemory(history);
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem }));

    loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93");
    expect(loop.getSessionId()).toBe("08001f8f-a6f5-4bb9-820d-df1e8366af93");
  });

  it("advances the session epoch for A → B → A, even when the session id repeats", () => {
    const history: GenericMessage[] = [{ role: "user", content: "resume me" }];
    const loop = new ConversationLoop(resumeDeps({
      memoryManager: {
        ...resumeMemory(history),
        saveSession: vi.fn(async () => {}),
      } as unknown as ConversationLoopDeps["memoryManager"],
    }));
    const initialEpoch = loop.getSessionEpoch();

    expect(initialEpoch).toBe(0);

    expect(loop.loadSession("08001f8f-a6f5-4bb9-820d-df1e8366af93")).toBe(true);
    expect(loop.getSessionEpoch()).toBe(initialEpoch + 1);

    loop.newConversation();
    expect(loop.getSessionEpoch()).toBe(initialEpoch + 2);

    expect(loop.loadSession("08001f8f-a6f5-4bb9-820d-df1e8366af93")).toBe(true);
    expect(loop.getSessionEpoch()).toBe(initialEpoch + 3);
  });

  it("clears prior carried-forward plugin scope when loading or creating a session", () => {
    const history: GenericMessage[] = [{ role: "user", content: "resume me" }];
    const loop = new ConversationLoop(resumeDeps({
      memoryManager: {
        ...resumeMemory(history),
        saveSession: vi.fn(async () => {}),
      } as unknown as ConversationLoopDeps["memoryManager"],
    }));
    const state = loop as unknown as { lastTurnScope: Set<string> | null };

    state.lastTurnScope = new Set(["previous-plugin"]);
    expect(loop.loadSession("08001f8f-a6f5-4bb9-820d-df1e8366af93")).toBe(true);
    expect(state.lastTurnScope).toBeNull();

    state.lastTurnScope = new Set(["loaded-plugin"]);
    loop.newConversation();
    expect(state.lastTurnScope).toBeNull();
  });

  it("does not load or merge parent transcript when resuming a child session", () => {
    const childHistory: GenericMessage[] = [{ role: "user", content: "child only" },
    ];
    const parentHistory: GenericMessage[] = [{ role: "user", content: "parent should not load" },
    ];
    const mem = {
      ...resumeMemory(null),
      loadSession: vi.fn((id: string) => {
        if (id === "3e323a73-28d0-4dce-8229-3b0eca68d32a") return childHistory;
        if (id === "a1bdc27a-c758-4a74-8955-5e9188412366") return parentHistory;
        return null;
      }),
      loadSessionMetadata: vi.fn((id: string) => {
        if (id === "3e323a73-28d0-4dce-8229-3b0eca68d32a") {
          return {
            parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
            summaryPreamble: "요약된 부모 맥락",
          };
        }
        return null;
      }),
    } as unknown as ConversationLoopDeps["memoryManager"];
    const systemPromptBuilder = {
      build: () => "system",
      setToolScope: vi.fn(),
      setSummaryPreamble: vi.fn(),
    } as unknown as ConversationLoopDeps["systemPromptBuilder"];
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem, systemPromptBuilder }),
    );

    const result = loop.resetAndResume("3e323a73-28d0-4dce-8229-3b0eca68d32a");

    expect(result.ok).toBe(true);
    expect(mem.loadSession).toHaveBeenCalledTimes(1);
    expect(mem.loadSession).toHaveBeenCalledWith("3e323a73-28d0-4dce-8229-3b0eca68d32a");
    expect(mem.loadSession).not.toHaveBeenCalledWith("a1bdc27a-c758-4a74-8955-5e9188412366");
    // The store stamps a row identity on restore; the claim here is that the
    // CHILD's rows loaded and the parent's did not.
    expect(loop.getHistory().getMessages()).toMatchObject(childHistory);
    expect(loop.getHistory().getMessages()).toHaveLength(childHistory.length);
    expect(systemPromptBuilder.setSummaryPreamble).toHaveBeenCalledWith("요약된 부모 맥락",
    );
  });

  it("sets cumulativeUsage estimate on resume for the next token preflight", () => {
    // Long synthetic history → estimateMessagesTokens > 0. Token preflight 가
    // next user turn 진입 시 이 값을 사용하여 임계 평가.
    const msgs: GenericMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "y".repeat(10_000),
      });
    }
    const mem = resumeMemory(msgs);
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem }));

    const result = loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93");
    expect(result.ok).toBe(true);
    // cumulativeUsage 가 estimate 로 set 됐는지 — token preflight 가 정확한 ratio 평가 가능
    expect(loop.getCumulativeUsage().inputTokens).toBe(estimateMessagesTokens(msgs),
    );
    // resetAndResume 자체는 더 이상 auto-compact 하지 않음 — token preflight 가 next turn 처리
    expect(result.compacted).toBe(false);
  });

  it("hydrates the context-fill SOT from the latest persisted turnSummary on resume", () => {
    const msgs: GenericMessage[] = [
      { role: "user", content: "old question" },
      {
        role: "assistant",
        content: "old answer",
        meta: {
          turnSummary: {
            turnDurationMs: 1_000,
            toolCount: 0,
            cumulativeToolMs: 0,
            tokensIn: 123_456,
            freshInputTokens: 10_000,
            tokensOut: 900,
          },
        },
      },
    ];
    const mem = resumeMemory(msgs);
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem }));

    const result = loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93");

    expect(result.ok).toBe(true);
    expect((loop as unknown as { lastContextInputTokens: number }).lastContextInputTokens,
    ).toBe(123_456);
    expect((loop as unknown as { lastRoundProviderInputTokens: number }).lastRoundProviderInputTokens,
    ).toBe(0);
  });

  it("hydrates post-compact context SOT ahead of preserved pre-compact turnSummary", () => {
    const msgs: GenericMessage[] = [
      {
        role: "user",
        content: "[compact boundary stub]",
        meta: {
          checkpointMeta: {
            removedMessages: 10,
            freedTokens: 90_000,
            compactNum: 1,
            trigger: "auto-compact",
            contextTokensAfter: 40_000,
          },
        },
      },
      {
        role: "assistant",
        content: "preserved old answer",
        meta: {
          turnSummary: {
            turnDurationMs: 1_000,
            toolCount: 0,
            cumulativeToolMs: 0,
            tokensIn: 123_456,
            freshInputTokens: 10_000,
            tokensOut: 900,
          },
        },
      },
    ];
    const mem = resumeMemory(msgs);
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem }));

    const result = loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93");

    expect(result.ok).toBe(true);
    expect((loop as unknown as { lastContextInputTokens: number }).lastContextInputTokens,
    ).toBe(40_000);
  });

  it("hydrates newer post-compact turnSummary ahead of an older checkpoint carrier", () => {
    const msgs: GenericMessage[] = [
      {
        role: "user",
        content: "[compact boundary stub]",
        meta: {
          createdAt: 2_000,
          checkpointMeta: {
            removedMessages: 10,
            freedTokens: 90_000,
            compactNum: 1,
            trigger: "auto-compact",
            contextTokensAfter: 40_000,
          },
        },
      },
      {
        role: "assistant",
        content: "post-compact answer",
        meta: {
          createdAt: 3_000,
          turnSummary: {
            turnDurationMs: 1_000,
            toolCount: 0,
            cumulativeToolMs: 0,
            tokensIn: 60_000,
            freshInputTokens: 12_000,
            tokensOut: 900,
          },
        },
      },
    ];
    const mem = resumeMemory(msgs);
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem }));

    const result = loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93");

    expect(result.ok).toBe(true);
    expect((loop as unknown as { lastContextInputTokens: number }).lastContextInputTokens,
    ).toBe(60_000);
  });

  it("passes resumed history plus the new user turn to the LLM provider", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ];
    const mem = resumeMemory(history);
    const routeEngine = {
      route: vi.fn().mockReturnValue({ route: "llm" }),
    } as unknown as ConversationLoopDeps["routeEngine"];
    const inputClassifier = {
      classify: vi.fn().mockReturnValue({ type: "chat" }),
    } as unknown as ConversationLoopDeps["inputClassifier"];
    const loop = new ConversationLoop(resumeDeps({
      memoryManager: mem,
      routeEngine,
        inputClassifier,
      settingsService: makeConversationLoopSettings(false, "gpt-4o", "openai",
        ),
    }),
    );
    let providerMessages: GenericMessage[] = [];
    const fakeProvider = {
      vendor: "openai" as const,
      streamTurn: async function* (params: { messages: GenericMessage[] }) {
        providerMessages = params.messages.map((message) => ({ ...message }));
        yield { type: "text_delta" as const, text: "new answer" };
        yield { type: "message_complete" as const };
      },
    };
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    expect(loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93").ok).toBe(true);
    await loop.runTurn("new question", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    expect(providerMessages.map((message) => message.content)).toEqual([
      "old question",
      "old answer",
      "new question",
    ]);
  });

  it("does not dispatch slash commands from non-keyboard origin", async () => {
    const routeEngine = {
      route: vi.fn().mockReturnValue({
        route: "command",
        command: "compact",
        args: "",
      }),
    } as unknown as ConversationLoopDeps["routeEngine"];
    const inputClassifier = {
      classify: vi.fn().mockReturnValue({ type: "command" }),
    } as unknown as ConversationLoopDeps["inputClassifier"];
    const loop = new ConversationLoop(resumeDeps({ routeEngine, inputClassifier }),
    );
    const fakeProvider = {
      vendor: "openai" as const,
      streamTurn: async function* () { /* unused */ },
    };
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    const result = await loop.runTurn("/compact", undefined, undefined, {
      inputOrigin: "plugin-emitted",
    });

    expect(result.text).toContain("비키보드 출처의 slash command는 실행하지 않습니다.",
    );
  });
});


describe("ConversationLoop.manualCompact — Major Fix callbacks", () => {
  it("no-op (short history): compacted:false", async () => {
    const mem = resumeMemory();
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem }));

    // Provider 없으면 early-return — 짧은 history 로 충분히 no-op 검증
    const result = await loop.manualCompact();

    expect(result.compacted).toBe(false);
  });

  it("manualCompact appends a checkpoint and persists summary", async () => {
    // Long enough history to trigger compact
    const longHistory = makeConversationLoopLongHistory(40);
    const mem = resumeMemory(longHistory);

    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem }));
    loop.resetAndResume("08001f8f-a6f5-4bb9-820d-df1e8366af93");

    // Inject a fake provider that returns a valid 12-section summary
    const fakeSummary = [
      "## Goal", "test goal",
      "## Constraints & Preferences", "none",
      "## Progress", "- [x] done",
      "## Key Decisions", "- decided",
      "## Relevant Files", "src/foo.ts:main:edited",
      "## Next Steps", "(미정)",
      "## Critical Context", "none",
      "## Current Plan", "step 1/1",
      "## Verification State", "build pass",
      "## Open Blockers", "none",
      "## Unsafe Pending Actions", "none",
      "## Last Tool Boundary", "none",
    ].join("\n");

    const fakeProvider = {
      vendor: "claude" as const,
      streamTurn: async function* () {
        yield { type: "text_delta" as const, text: fakeSummary };
        yield { type: "message_complete" as const };
      },
    };
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    const result = await loop.manualCompact();

    if (result.compacted) {
      // manualCompact 는 callbacks 파라미터가 없으므로 onCompactOccurred 는 호출 안 됨.
      // 이 테스트는 checkpoint 영속화 (appendCheckpoint + saveSessionMetadata) 를 검증.
      expect(result.compacted).toBe(true);
      expect(result.removedMessageCount).toBeGreaterThan(0);
      // appendCheckpoint and saveSessionMetadata must have been called.
      expect((mem as { appendCheckpoint: ReturnType<typeof vi.fn> }).appendCheckpoint,
      ).toHaveBeenCalled();
      expect((mem as { saveSessionMetadata: ReturnType<typeof vi.fn> }).saveSessionMetadata,
      ).toHaveBeenCalled();
    }
  });
});

describe("ConversationLoop command routing", () => {
  it("/memory lists memory entries only", async () => {
    const listMemoryEntries = vi.fn(() => [{ title: "사용자 기억", filename: "memory-note.md", content: "# 사용자 기억",
      },
    ]);
    const mem = {
      ...resumeMemory(),
      listMemoryEntries,
    } as unknown as ConversationLoopDeps["memoryManager"];
    const routeEngine = {
      route: vi.fn().mockReturnValue({ route: "command", command: "memory", args: "" }),
    } as unknown as ConversationLoopDeps["routeEngine"];
    const inputClassifier = {
      classify: vi.fn().mockReturnValue({ type: "command" }),
    } as unknown as ConversationLoopDeps["inputClassifier"];
    const fakeProvider = {
      vendor: "openai" as const,
      streamTurn: async function* () { /* unused */ },
    };
    const loop = new ConversationLoop(resumeDeps({ memoryManager: mem, routeEngine, inputClassifier }),
    );
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    const result = await loop.runTurn("/memory", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    expect(result.text).toContain("사용자 기억");
    expect(listMemoryEntries).toHaveBeenCalledOnce();
  });

  it("/remember sends the user text to captureExplicit without raw direct persistence", async () => {
    const captureExplicit = vi.fn<CaptureExplicit>(async () => ({
      status: "saved",
      entry: {
        filename: "reviewed-rollout.md",
        title: "Reviewed rollout preference",
        content: "# Reviewed rollout preference\n\nUse a staged rollout.\n",
      },
    }));
    const { loop, saveMemory } = createRememberCommandLoop(captureExplicit);

    const result = await loop.runTurn("/remember retain this rollout preference", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(captureExplicit).toHaveBeenCalledWith({
      title: "retain this rollout preference",
      content: "retain this rollout preference",
    });
    expect(saveMemory).not.toHaveBeenCalled();
    expect(result.text).toBe(t("be_conversationLoop.cmdRememberSaved", { title: "Reviewed rollout preference" }));
  });

  it("/remember returns not-saved when captureExplicit skips review", async () => {
    const captureExplicit = vi.fn<CaptureExplicit>(async () => ({
      status: "skipped",
      reason: "invalid-review",
    }));
    const { loop, saveMemory } = createRememberCommandLoop(captureExplicit);

    const result = await loop.runTurn("/remember retain this rollout preference", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(captureExplicit).toHaveBeenCalledOnce();
    expect(saveMemory).not.toHaveBeenCalled();
    expect(result.text).toBe(t("be_conversationLoop.cmdRememberNotSaved"));
  });

  it("/remember returns not-saved when captureExplicit throws", async () => {
    const captureExplicit = vi.fn<CaptureExplicit>(async () => {
      throw new Error("reviewer unavailable");
    });
    const { loop, saveMemory } = createRememberCommandLoop(captureExplicit);

    const result = await loop.runTurn("/remember retain this rollout preference", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(captureExplicit).toHaveBeenCalledOnce();
    expect(saveMemory).not.toHaveBeenCalled();
    expect(result.text).toBe(t("be_conversationLoop.cmdRememberNotSaved"));
  });

  it("/permission hooks accept restores a boot-quarantined hook through the user-keyboard command path", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "permission-policy-loop-hooks-"));
    const hooksDir = join(tmpDir, "hooks");
    const disabledDir = join(hooksDir, ".disabled");
    const lockfilePath = join(hooksDir, ".lockfile.json");
    try {
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "pre-demo.sh");
      writeFileSync(hookPath, "#!/bin/sh\necho '{}'\n");
      chmodSync(hookPath, 0o700);
      const boot = await wireHookSystem({ hooksDir, disabledDir, lockfilePath,
      });
      expect(boot.manager.size()).toBe(0);
      expect(existsSync(join(disabledDir, "pre-demo.sh"))).toBe(true);

      const routeEngine = {
        route: vi.fn().mockReturnValue({
          route: "command",
          command: "permission",
          args: "hooks accept pre-demo.sh",
        }),
      } as unknown as ConversationLoopDeps["routeEngine"];
      const inputClassifier = {
        classify: vi.fn().mockReturnValue({ type: "command" }),
      } as unknown as ConversationLoopDeps["inputClassifier"];
      const loop = new ConversationLoop(resumeDeps({
        routeEngine,
          inputClassifier,
        scriptHookManager: boot.manager,
        hookTrustCommandOptions: { hooksDir, disabledDir, lockfilePath },
      }),
      );
      const fakeProvider = {
        vendor: "openai" as const,
        streamTurn: async function* () { /* unused */ },
      };
      (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

      const result = await loop.runTurn("/permission hooks accept pre-demo.sh", undefined, undefined, { inputOrigin: "user-keyboard" },
      );

      expect(result.text).toContain("Hook 신뢰 등록됨: pre-demo.sh");
      expect(boot.manager.size()).toBe(1);
      expect(existsSync(join(hooksDir, "pre-demo.sh"))).toBe(true);
    } finally {
      await cleanupTmpDir(tmpDir);
    }
  });
});
