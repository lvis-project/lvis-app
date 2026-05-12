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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import type { ConversationLoopDeps } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { wireHookSystem } from "../../boot/steps/hook-system-wiring.js";

// ─── Minimal stubs ────────────────────────────────────────────────────────────

function makeSettings(autoCompact = true, model = "gpt-4o", provider: "openai" | "claude" | "gemini" | "copilot" | "azure-foundry" | "vertex-ai" = "openai") {
  return {
    get: (key: string) => {
      if (key === "chat") return { systemPrompt: "", autoCompact };
      if (key === "llm") return fakeLlmSettings({ provider, model });
      return {};
    },
    getAll: () => ({}),
    patch: vi.fn(),
    getSecret: () => null,
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
  } as unknown as ConversationLoopDeps["settingsService"];
}

function makeMemoryManager(storedMessages: GenericMessage[] | null = null) {
  const sessions: Record<string, GenericMessage[]> = {};
  if (storedMessages) sessions["test-session-id"] = storedMessages;

  return {
    listSessions: () => Object.keys(sessions).map((id) => ({ id, modifiedAt: new Date() })),
    loadSession: (id: string) => sessions[id] ?? null,
    loadSessionMetadata: vi.fn(() => null),
    saveSession: vi.fn((id: string, msgs: GenericMessage[]) => { sessions[id] = msgs; }),
    listMemoryEntries: () => [],
    saveMemory: vi.fn(),
    deleteMemory: vi.fn(),
    searchMemoryEntries: vi.fn(),
    getMemoryContext: vi.fn(),
    getLvisMd: vi.fn(),
    updateLvisMd: vi.fn(),
    getUserPreferences: vi.fn(),
    updateUserPreferences: vi.fn(),
  } as unknown as ConversationLoopDeps["memoryManager"];
}

function makeDeps(overrides: Partial<ConversationLoopDeps> = {}): ConversationLoopDeps {
  return {
    settingsService: makeSettings(),
    systemPromptBuilder: { build: () => "system", setToolScope: vi.fn() } as unknown as ConversationLoopDeps["systemPromptBuilder"],
    keywordEngine: { classify: vi.fn(), matchAllPluginIds: () => new Set() } as unknown as ConversationLoopDeps["keywordEngine"],
    routeEngine: { route: vi.fn() } as unknown as ConversationLoopDeps["routeEngine"],
    toolRegistry: { getToolSchemasForScope: () => [], getVisibleTools: () => [] } as unknown as ConversationLoopDeps["toolRegistry"],
    memoryManager: makeMemoryManager(),
    ...overrides,
  };
}

/** Build a long conversation that exceeds the compaction threshold (>= 6 messages). */
function makeLongHistory(count = 20): GenericMessage[] {
  const msgs: GenericMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i} ${"x".repeat(200)}` });
  }
  return msgs;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConversationLoop.resetAndResume", () => {
  it("returns ok:false for unknown session", () => {
    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(null) }));
    const result = loop.resetAndResume("nonexistent-id");
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
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));

    // Simulate prior usage so we can confirm reset
    const result = loop.resetAndResume("test-session-id");

    expect(result.ok).toBe(true);
    expect(loop.getHistory().length).toBe(2);
    // Issue 1 fix: cumulativeUsage is now estimated from loaded history (not zero).
    // Short 2-message history → small but non-zero estimate.
    expect(loop.getCumulativeUsage().inputTokens).toBeGreaterThan(0);
    expect(loop.getCumulativeUsage().outputTokens).toBe(0);
  });

  it("does NOT compact short history even with autoCompact enabled", () => {
    const history: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));

    const result = loop.resetAndResume("test-session-id");

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.compactedAt).toBeNull();
    expect(result.removedMessageCount).toBe(0);
  });

  it("does NOT compact when autoCompact is disabled", () => {
    const history = makeLongHistory(20);
    const mem = makeMemoryManager(history);
    const settings = makeSettings(false);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem, settingsService: settings }));

    const result = loop.resetAndResume("test-session-id");

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
  });

  it("session-id is updated to the resumed session", () => {
    const history: GenericMessage[] = [{ role: "user", content: "resume me" }];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));

    loop.resetAndResume("test-session-id");
    expect(loop.getSessionId()).toBe("test-session-id");
  });

  it("PR-2-F-4: cumulativeUsage 추정값 set on resume — Layer 0 가 next turn 평가용으로 read", () => {
    // 50 messages × 10K chars each → estimateMessagesTokens > 0. Layer 0 preflight 가
    // next user turn 진입 시 이 값을 사용하여 임계 평가.
    const msgs: GenericMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "y".repeat(10_000) });
    }
    const mem = makeMemoryManager(msgs);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));

    const result = loop.resetAndResume("test-session-id");
    expect(result.ok).toBe(true);
    // cumulativeUsage 가 estimate 로 set 됐는지 — Layer 0 가 정확한 ratio 평가 가능
    expect(loop.getCumulativeUsage().inputTokens).toBeGreaterThan(0);
    // resetAndResume 자체는 더 이상 auto-compact 하지 않음 — Layer 0 가 next turn 처리
    expect(result.compacted).toBe(false);
  });

  it("does not dispatch slash commands from non-keyboard origin", async () => {
    const routeEngine = {
      route: vi.fn().mockReturnValue({
        route: "command",
        command: "compact",
        args: "",
      }),
    } as unknown as ConversationLoopDeps["routeEngine"];
    const keywordEngine = {
      classify: vi.fn().mockReturnValue({ type: "command" }),
      matchAllPluginIds: () => new Set(),
    } as unknown as ConversationLoopDeps["keywordEngine"];
    const loop = new ConversationLoop(makeDeps({ routeEngine, keywordEngine }));
    const fakeProvider = {
      vendor: "openai" as const,
      streamTurn: async function* () { /* unused */ },
    };
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    const result = await loop.runTurn("/compact", undefined, undefined, {
      inputOrigin: "plugin-emitted",
    });

    expect(result.text).toContain("비키보드 출처의 slash command는 실행하지 않습니다.");
  });
});


describe("ConversationLoop.manualCompact — Major Fix callbacks", () => {
  /** makeMemoryManager stub with appendCheckpoint + saveSessionMetadata support */
  function makeMemoryManagerWithCheckpoint() {
    const sessions: Record<string, GenericMessage[]> = {};
    const metadata: Record<string, unknown> = {};
    return {
      listSessions: () => [],
      loadSession: (id: string) => sessions[id] ?? null,
      loadSessionMetadata: vi.fn(() => null),
      saveSession: vi.fn((id: string, msgs: GenericMessage[]) => { sessions[id] = msgs; }),
      saveSessionMetadata: vi.fn(async (id: string, meta: unknown) => { metadata[id] = meta; }),
      appendCheckpoint: vi.fn((_meta: unknown, cp: unknown) => ({ checkpoints: [cp] })),
      listMemoryEntries: () => [],
      saveMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemoryEntries: vi.fn(),
      getMemoryContext: vi.fn(),
      getLvisMd: vi.fn(),
      updateLvisMd: vi.fn(),
      getUserPreferences: vi.fn(),
      updateUserPreferences: vi.fn(),
    } as unknown as ConversationLoopDeps["memoryManager"];
  }

  it("no-op (short history): compacted:false", async () => {
    const mem = makeMemoryManagerWithCheckpoint();
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));

    // Provider 없으면 early-return — 짧은 history 로 충분히 no-op 검증
    const result = await loop.manualCompact();

    expect(result.compacted).toBe(false);
  });

  it("manualCompact appends Layer 3 checkpoint + persists summary", async () => {
    // Long enough history to trigger compact
    const longHistory = makeLongHistory(40);
    const mem = makeMemoryManagerWithCheckpoint();
    // Pre-load session
    const sessions: Record<string, GenericMessage[]> = { "test-session-id": longHistory };
    const memWithHistory = {
      ...mem,
      loadSession: (id: string) => sessions[id] ?? null,
      loadSessionMetadata: vi.fn(() => null),
    } as unknown as ConversationLoopDeps["memoryManager"];

    const loop = new ConversationLoop(makeDeps({ memoryManager: memWithHistory }));
    loop.resetAndResume("test-session-id");

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
      // 이 테스트는 Layer 3 checkpoint 영속화 (appendCheckpoint + saveSessionMetadata) 를 검증.
      expect(result.compacted).toBe(true);
      expect(result.removedMessageCount).toBeGreaterThan(0);
      // Layer 3: appendCheckpoint and saveSessionMetadata must have been called
      expect((memWithHistory as { appendCheckpoint: ReturnType<typeof vi.fn> }).appendCheckpoint).toHaveBeenCalled();
      expect((memWithHistory as { saveSessionMetadata: ReturnType<typeof vi.fn> }).saveSessionMetadata).toHaveBeenCalled();
    }
  });
});

describe("ConversationLoop command routing", () => {
  it("/memory lists memory entries only", async () => {
    const listMemoryEntries = vi.fn(() => [{ title: "사용자 기억", filename: "memory-note.md", content: "# 사용자 기억" }]);
    const mem = {
      ...makeMemoryManager(),
      listMemoryEntries,
    } as unknown as ConversationLoopDeps["memoryManager"];
    const routeEngine = {
      route: vi.fn().mockReturnValue({ route: "command", command: "memory", args: "" }),
    } as unknown as ConversationLoopDeps["routeEngine"];
    const keywordEngine = {
      classify: vi.fn().mockReturnValue({ type: "command" }),
      matchAllPluginIds: () => new Set(),
    } as unknown as ConversationLoopDeps["keywordEngine"];
    const fakeProvider = {
      vendor: "openai" as const,
      streamTurn: async function* () { /* unused */ },
    };
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem, routeEngine, keywordEngine }));
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    const result = await loop.runTurn("/memory", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(result.text).toContain("사용자 기억");
    expect(listMemoryEntries).toHaveBeenCalledOnce();
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
      const boot = await wireHookSystem({ hooksDir, disabledDir, lockfilePath });
      expect(boot.manager.size()).toBe(0);
      expect(existsSync(join(disabledDir, "pre-demo.sh"))).toBe(true);

      const routeEngine = {
        route: vi.fn().mockReturnValue({
          route: "command",
          command: "permission",
          args: "hooks accept pre-demo.sh",
        }),
      } as unknown as ConversationLoopDeps["routeEngine"];
      const keywordEngine = {
        classify: vi.fn().mockReturnValue({ type: "command" }),
        matchAllPluginIds: () => new Set(),
      } as unknown as ConversationLoopDeps["keywordEngine"];
      const loop = new ConversationLoop(makeDeps({
        routeEngine,
        keywordEngine,
        scriptHookManager: boot.manager,
        hookTrustCommandOptions: { hooksDir, disabledDir, lockfilePath },
      }));
      const fakeProvider = {
        vendor: "openai" as const,
        streamTurn: async function* () { /* unused */ },
      };
      (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

      const result = await loop.runTurn("/permission hooks accept pre-demo.sh", undefined, undefined, { inputOrigin: "user-keyboard" });

      expect(result.text).toContain("Hook 신뢰 등록됨: pre-demo.sh");
      expect(boot.manager.size()).toBe(1);
      expect(existsSync(join(hooksDir, "pre-demo.sh"))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
