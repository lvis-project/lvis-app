import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { createReadToolResultChunkTool } from "../../tools/tool-result-chunk.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { MAX_AGENT_SPAWNS_PER_ROUND } from "../../shared/subagent-policy.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { SkillStore } from "../../main/skill-store.js";
import { createSkillLoadTool } from "../../tools/skill-load.js";
import { MCP_RESOURCE_FENCE_OPEN } from "../../shared/mcp-resource-bounds.js";
import type { SubscriptionRuntimeId } from "../../shared/subscription-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { TurnCallbacks, TurnDecisionEvent } from "../turn/types.js";

/** Derived so a widened callback union cannot drift from this file again. */
type AssistantRoundStopReason =
  Parameters<NonNullable<TurnCallbacks["onAssistantRound"]>>[0]["stopReason"];
import { genericToModelMessages, fullStreamToStreamEvent } from "../llm/vercel/adapter.js";
import { t } from "../../i18n/index.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT } from "../llm/output-token-limit.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

class RecordingPromptProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly systemPrompts: string[] = [];
  readonly messages: GenericMessage[][] = [];
  readonly params: StreamTurnParams[] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.systemPrompts.push(input.systemPrompt);
    this.messages.push(input.messages);
    this.params.push(input);
    yield* this.turns[this.index++] ?? [];
  }
}

class SubscriptionRecordingPromptProvider extends RecordingPromptProvider {
  readonly subscriptionRuntime: Readonly<{
    kind: "subscription";
    provider: SubscriptionRuntimeId;
  }>;

  constructor(turns: StreamEvent[][], provider: SubscriptionRuntimeId = "codex") {
    super(turns);
    this.subscriptionRuntime = { kind: "subscription", provider };
  }
}

function withoutRuntimeMeta(messages: ReadonlyArray<GenericMessage>) {
  return messages.map((message) => {
    const { meta, ...rest } = message;
    if (!meta) return rest;
    const {
      createdAt: _createdAt,
      messageId: _messageId,
      turnSummary: _turnSummary,
      toolDisplay: _toolDisplay,
      ...stableMeta
    } = meta;
    return Object.keys(stableMeta).length > 0 ? { ...rest, meta: stableMeta } : rest;
  });
}

describe("ConversationLoop queryLoop", () => {
  it("clears per-turn prompt builder state when prompt assembly throws", async () => {
    const toolRegistry = new ToolRegistry();
    const setOriginSource = vi.fn();
    const setActiveSessionId = vi.fn();
    const setActiveRolePrompt = vi.fn();
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => {
          throw new Error("prompt assembly failed");
        },
        setOriginSource,
        setActiveSessionId,
        setActiveRolePrompt,
        setToolScope: vi.fn(),
      },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = new FakeProvider([]);

    await expect(loop.runTurn("질문", undefined, undefined, {
      inputOrigin: "user-keyboard",
      originSource: "overlay:test",
      rolePrompt: { id: "reviewer", name: "Reviewer", systemPromptAdd: "Review carefully.",
        },
    }),
    ).rejects.toThrow("prompt assembly failed");

    expect(setOriginSource).toHaveBeenNthCalledWith(1, "overlay:test");
    expect(setOriginSource).toHaveBeenLastCalledWith(null);
    expect(setActiveSessionId).toHaveBeenNthCalledWith(1, expect.any(String));
    expect(setActiveSessionId).toHaveBeenLastCalledWith(null);
    expect(setActiveRolePrompt).toHaveBeenNthCalledWith(1, {
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Review carefully.",
    });
    expect(setActiveRolePrompt).toHaveBeenLastCalledWith(null);
  });
  it("routes subscription turns through the ordinary prompt, history, and tool schemas", async () => {
    const secret = "subscription-turn-secret";
    const provider = new SubscriptionRecordingPromptProvider([
      [
        { type: "tool_call", id: "subscription-list", name: "list_directory", input: { path: "src" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const build = vi.fn(() => "PROJECT_SECRET_SYSTEM_PROMPT");
    const execute = vi.fn(async () => ({ output: "src", isError: false }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "list_directory",
      description: "List files",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      isReadOnly: () => true,
      execute,
    }));
    const settings = {
      ...fakeLlmSettings(),
      activeChatRuntime: { kind: "subscription" as const, provider: "codex" as const },
    };
    // These values belong to the inactive API-key OpenAI configuration. The
    // common query loop must not serialize them into a login-backed runtime.
    settings.vendors.openai.enableThinking = true;
    settings.vendors.openai.thinkingBudgetTokens = 32_000;

    const loop = new ConversationLoop({
      settingsService: {
        get: () => settings,
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;
    loop.getHistory().append({
      role: "user",
      content: [
        { type: "text", text: "prior ordinary text" },
        { type: "file", data: secret, mimeType: "application/secret" },
      ],
    });
    build.mockClear();

    const result = await loop.runTurn("ordinary user text", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(build).toHaveBeenCalled();
    expect(provider.systemPrompts).toEqual([
      "PROJECT_SECRET_SYSTEM_PROMPT",
      "PROJECT_SECRET_SYSTEM_PROMPT",
    ]);
    expect(provider.params[0]?.model).toBe("default");
    expect(JSON.stringify(provider.params[0]?.tools)).toContain("list_directory");
    expect(provider.params[0]?.enableThinking).toBe(false);
    expect(provider.params[0]).not.toHaveProperty("thinkingBudgetTokens");
    expect(JSON.stringify(provider.messages[0])).toContain(secret);
    expect(JSON.stringify(provider.messages[0])).toContain("ordinary user text");
    expect(execute).toHaveBeenCalledWith({ path: "src" }, expect.anything());
    expect(result).toMatchObject({
      text: "answer",
      toolCalls: [{ name: "list_directory", input: { path: "src" }, result: "src" }],
    });
  });


  it("persists persona prompt identity on the user message for retry replay", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
        setActiveRolePrompt: vi.fn(),
      },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("review this", undefined, undefined, {
      inputOrigin: "user-keyboard",
      rolePrompt: { id: "reviewer", name: "Reviewer", systemPromptAdd: "Review carefully.",
      },
    });

    const [firstMessage] = withoutRuntimeMeta(loop.getHistory().getMessages());
    expect(firstMessage).toEqual({
      role: "user",
      content: "review this",
      meta: {
        activePersonaPrompt: {
          id: "reviewer",
          name: "Reviewer",
        },
      },
    });
  });

  it("clears skill overlay at user-turn boundaries", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const clear = vi.fn();
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
        setToolScope: vi.fn(),
        setActiveSessionId: vi.fn(),
      },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      skillOverlay: { clear },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("질문", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    expect(clear).toHaveBeenCalledTimes(2);
    expect(clear.mock.calls[0][0]).toBe(clear.mock.calls[1][0]);
  });

  it("injects a loaded skill body only for the active user turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-turn-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "brief.md"),
        "---\nname: brief\ndescription: Brief writer\n---\nBODY ONLY THIS TURN",
        "utf8",
      );
      const toolRegistry = new ToolRegistry();
      const overlay = new SkillOverlay();
      toolRegistry.register(createSkillLoadTool({
        store: new SkillStore({ userDir: dir }),
        overlay,
        approvals: {
          isApproved: async () => true,
          approve: async () => undefined,
        } as never,
        approvalGate: undefined as never,
        emit: () => undefined,
      }),
      );
      let activeSessionId: string | null = null;
      const provider = new RecordingPromptProvider([
        [
          { type: "tool_call", id: "tu-1", name: "skill_load", input: { skillName: "brief" },
          },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
        [
          { type: "text_delta", text: "next" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ]);
      const loop = new ConversationLoop({
        settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
        },
        systemPromptBuilder: {
          build: () => activeSessionId ? overlay.buildSection(activeSessionId) : "",
          setToolScope: vi.fn(),
          setActiveSessionId: (sessionId: string | null) => {
            activeSessionId = sessionId;
          },
        },
        inputClassifier: new InputClassifier(),
        routeEngine: new RouteEngine(),
        toolRegistry,
        memoryManager: { saveSession: () => {}, listSessions: () => [] },
        skillOverlay: overlay,
        disableSessionPersistence: true,
      } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
      (loop as { provider: LLMProvider | null }).provider = provider;

      await loop.runTurn("brief me", undefined, undefined, { inputOrigin: "user-keyboard",
      });
      await loop.runTurn("new topic", undefined, undefined, { inputOrigin: "user-keyboard",
      });

      expect(provider.systemPrompts[0]).not.toContain("BODY ONLY THIS TURN");
      expect(provider.systemPrompts[1]).toContain("BODY ONLY THIS TURN");
      expect(provider.systemPrompts[2]).not.toContain("BODY ONLY THIS TURN");
      expect(JSON.stringify(provider.messages[1])).not.toContain("BODY ONLY THIS TURN",
      );
      expect(JSON.stringify(loop.getHistory().getMessages())).not.toContain("BODY ONLY THIS TURN",
      );
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("uses the sessionIdOverride when rebuilding the skill overlay prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-child-turn-"));
    try {
      writeFileSync(
        join(dir, "brief.md"),
        "---\nname: brief\ndescription: Brief current turn\n---\nCHILD BODY ONLY",
        "utf-8",
      );
      const overlay = new SkillOverlay();
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(createSkillLoadTool({
        store: new SkillStore({ userDir: dir }),
        overlay,
        approvals: {
          isApproved: async () => true,
          approve: async () => undefined,
        } as never,
        approvalGate: undefined as never,
        emit: () => undefined,
      }),
      );
      let activeSessionId: string | null = null;
      const provider = new RecordingPromptProvider([
        [
          { type: "tool_call", id: "tu-1", name: "skill_load", input: { skillName: "brief" },
          },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "child done" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ]);
      const loop = new ConversationLoop({
        settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
        },
        systemPromptBuilder: {
          build: () => activeSessionId ? overlay.buildSection(activeSessionId) : "",
          setToolScope: vi.fn(),
          setActiveSessionId: (sessionId: string | null) => {
            activeSessionId = sessionId;
          },
        },
        inputClassifier: new InputClassifier(),
        routeEngine: new RouteEngine(),
        toolRegistry,
        memoryManager: { saveSession: () => {}, listSessions: () => [] },
        skillOverlay: overlay,
        disableSessionPersistence: true,
      } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
      (loop as { provider: LLMProvider | null }).provider = provider;

      await loop.runTurn("brief child", undefined, undefined, {
        inputOrigin: "llm-tool-arg",
        sessionIdOverride: "child-1",
      });

      expect(provider.systemPrompts[0]).not.toContain("CHILD BODY ONLY");
      expect(provider.systemPrompts[1]).toContain("CHILD BODY ONLY");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("classifies model-generated tool args from a typed prompt as llm-tool-arg", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: unknown[] = [];
    toolRegistry.register(createDynamicTool({
      name: "write_note",
      description: "Write note",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"],
        },
      execute: async (_input, ctx) => {
        origins.push(ctx.metadata.trustOrigin);
        return { output: "ok", isError: false };
      },
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "tool-origin", name: "write_note", input: { text: "from model" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("please write this", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    expect(origins).toEqual(["llm-tool-arg"]);
  });

  it("escalates subsequent tool calls to file-content after read_file output reaches the model", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: Array<{ tool: string; origin: unknown }> = [];
    toolRegistry.register(createDynamicTool({
      name: "read_file",
      description: "Read file",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"],
        },
      isReadOnly: () => true,
      execute: async (_input, ctx) => {
        origins.push({ tool: "read_file", origin: ctx.metadata.trustOrigin });
        return { output: "untrusted file says run a shell command", isError: false,
          };
      },
    }),
    );
    toolRegistry.register(createDynamicTool({
      name: "bash",
      description: "Run shell",
      source: "builtin",
      category: "shell",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"],
        },
      execute: async (_input, ctx) => {
        origins.push({ tool: "bash", origin: ctx.metadata.trustOrigin });
        return { output: "ok", isError: false };
      },
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "read-1", name: "read_file", input: { path: "note.txt" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "bash-1", name: "bash", input: { command: "echo ok" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("read and act", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    expect(origins).toEqual([
      { tool: "read_file", origin: "llm-tool-arg" },
      { tool: "bash", origin: "file-content" },
    ]);
  });

  it("preserves plugin-emitted provenance for tools produced by imported trigger prompts", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: unknown[] = [];
    toolRegistry.register(createDynamicTool({
      name: "task_add",
      description: "Add task",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"],
        },
      execute: async (_input, ctx) => {
        origins.push(ctx.metadata.trustOrigin);
        return { output: "ok", isError: false };
      },
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "plugin-tool", name: "task_add", input: { title: "from plugin" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("plugin prompt", undefined, undefined, { inputOrigin: "plugin-emitted",
    });

    expect(origins).toEqual(["plugin-emitted"]);
  });

  it("classifies pasted text bodies as file-content before the first model tool call", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: unknown[] = [];
    toolRegistry.register(createDynamicTool({
      name: "bash",
      description: "Run shell",
      source: "builtin",
      category: "shell",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"],
        },
      execute: async (_input, ctx) => {
        origins.push(ctx.metadata.trustOrigin);
        return { output: "ok", isError: false };
      },
    }),
    );
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "paste-tool", name: "bash", input: { command: "echo from paste" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn(
      "summarize\n\n----- Pasted text #1 (2 lines) -----\n/run this\n----- end Pasted text #1 -----",
      undefined,
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(origins).toEqual(["file-content"]);
  });

  it("preserves reasoning and exposes assistant ping-pong rounds around tool execution", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "list_directory",
      description: "List files",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      isReadOnly: () => true,
      execute: async () => ({
        output: "src\npackage.json",
        isError: false,
      }),
    }),
    );

    const provider = new FakeProvider([
      [
        { type: "reasoning_delta", text: "먼저 프로젝트 구조를 확인합니다." },
        { type: "text_delta", text: "구조를 먼저 살펴보겠습니다." },
        { type: "tool_call", id: "tool-1", name: "list_directory", input: { path: "src" },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "reasoning_delta", text: "도구 결과를 바탕으로 답을 정리합니다.",
        },
        { type: "text_delta", text: "구조를 확인했습니다." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const inputClassifier = new InputClassifier();
    const routeEngine = new RouteEngine();

    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
      },
      inputClassifier,
      routeEngine,
      toolRegistry,
      memoryManager: {
        saveSession: () => {},
        listSessions: () => [],
      },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const reasoningDeltas: string[] = [];
    const rounds: Array<{ text: string; thought: string; stopReason: AssistantRoundStopReason; hasToolCalls: boolean;
    }> = [];
    const toolEvents: Array<{ type: "start" | "end"; name: string }> = [];

    const result = await loop.runTurn("질문", {
      onReasoningDelta: (text) => reasoningDeltas.push(text),
      onAssistantRound: ({ text, thought, stopReason, hasToolCalls }) => {
        rounds.push({ text, thought, stopReason, hasToolCalls });
      },
      onToolStart: (name) => toolEvents.push({ type: "start", name }),
      onToolEnd: (name) => toolEvents.push({ type: "end", name }),
    }, undefined, { inputOrigin: "user-keyboard" },
    );

    expect(result).toMatchObject({
      text: "구조를 확인했습니다.",
      toolCalls: [{
        name: "list_directory",
        input: { path: "src" },
        result: "src\npackage.json",
      },
      ],
    });
    expect(reasoningDeltas).toEqual([
      "먼저 프로젝트 구조를 확인합니다.",
      "도구 결과를 바탕으로 답을 정리합니다.",
    ]);
    expect(rounds).toEqual([
      {
        text: "구조를 먼저 살펴보겠습니다.",
        thought: "먼저 프로젝트 구조를 확인합니다.",
        stopReason: "tool_use",
        hasToolCalls: true,
      },
      {
        text: "구조를 확인했습니다.",
        thought: "도구 결과를 바탕으로 답을 정리합니다.",
        stopReason: "end_turn",
        hasToolCalls: false,
      },
    ]);
    expect(toolEvents).toEqual([
      { type: "start", name: "list_directory" },
      { type: "end", name: "list_directory" },
    ]);
    expect(withoutRuntimeMeta(loop.getHistory().getMessages())).toEqual([
      { role: "user", content: "질문" },
      {
        role: "assistant",
        content: "구조를 먼저 살펴보겠습니다.",
        thought: "먼저 프로젝트 구조를 확인합니다.",
        // The persisted call names the registry entry it invoked, so a reloaded
        // transcript can still attribute it (builtin here; plugin/MCP calls
        // carry their owner the same way).
        toolCalls: [
          {
            id: "tool-1",
            name: "list_directory",
            input: { path: "src" },
            source: "builtin",
            category: "read",
          },
        ],
      },
      {
        role: "tool_result",
        toolUseId: "tool-1",
        toolName: "list_directory",
        content: "src\npackage.json",
      },
      {
        role: "assistant",
        content: "구조를 확인했습니다.",
        thought: "도구 결과를 바탕으로 답을 정리합니다.",
      },
    ]);
  });

  // R2-CR-1: per-round fan-out cap must not orphan tool_use ids in history.
  // If the LLM emits >MAX_TOOL_CALLS_PER_ROUND (5) tool_use blocks in one
  // round, only the capped slice may be persisted — every tool_use block in
  // assistant history MUST have a matching tool_result block in the next
  // user turn, otherwise Anthropic + OpenAI strict APIs 400 the next request.
  it("R2-CR-1: per-round fan-out cap persists only the capped slice (5) so tool_use/tool_result counts match", async () => {
    expect(MAX_AGENT_SPAWNS_PER_ROUND).toBe(5);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "noop",
      description: "no-op tool",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }),
    );

    // Round 1: LLM emits 15 tool_use blocks (5 over the cap).
    // Round 2: LLM ends the turn cleanly.
    const fifteenToolCalls = Array.from({ length: 15 }).map((_, i) => ({
      type: "tool_call" as const,
      id: `tu-${i}`,
      name: "noop",
      input: {},
    }));
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "calling many" },
        ...fifteenToolCalls,
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const inputClassifier = new InputClassifier();
    const routeEngine = new RouteEngine();
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier,
      routeEngine,
      toolRegistry,
      memoryManager: {
        saveSession: () => {},
        listSessions: () => [],
      },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("call many tools", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    const messages = loop.getHistory().getMessages();
    // Find the assistant message that committed the over-cap tool_use round.
    const assistantWithTools = messages.find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray((m as { toolCalls?: unknown[] }).toolCalls),
    ) as { toolCalls: Array<{ id: string }> } | undefined;
    expect(assistantWithTools).toBeDefined();
    // CRITICAL: assistant history must contain exactly the host fan-out cap.
    expect(assistantWithTools!.toolCalls).toHaveLength(
      MAX_AGENT_SPAWNS_PER_ROUND,
    );

    // CRITICAL: tool_result count in history must match the persisted
    // tool_use count. Any other ratio = next API request 400s.
    const toolResults = messages.filter((m) => m.role === "tool_result");
    expect(toolResults).toHaveLength(MAX_AGENT_SPAWNS_PER_ROUND);

    // The persisted tool_use ids must be the first capped slice, not
    // a later subset, and every persisted tool_use id has a matching
    // tool_result.toolUseId.
    const persistedIds = assistantWithTools!.toolCalls.map((tc) => tc.id);
    expect(persistedIds).toEqual(
      Array.from({ length: MAX_AGENT_SPAWNS_PER_ROUND }).map(
        (_, i) => `tu-${i}`,
      ),
    );
    const resultIds = toolResults.map(
      (m) => (m as { toolUseId: string }).toolUseId,
    );
    expect(resultIds.sort()).toEqual(persistedIds.slice().sort());
  });

  it("answers a call whose arguments never parsed with an error and keeps executing the rest", async () => {
    const executed: string[] = [];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "noop",
      description: "no-op tool",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (rawInput: unknown) => {
        executed.push(JSON.stringify(rawInput));
        return { output: "ok", isError: false };
      },
    }),
    );

    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "calling two" },
        { type: "tool_call", id: "tu-good", name: "noop", input: { a: 1 } },
        {
          type: "tool_call",
          id: "tu-broken",
          name: "noop",
          input: {},
          invalidInput: {
            raw: '{"command":"echo hel',
            reason: "unparsable-json",
            rawChars: 20,
          },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;
    const decisions: TurnDecisionEvent[] = [];

    const result = await loop.runTurn(
      "call two tools",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    // The malformed call never reaches the executor; the healthy one does.
    expect(executed).toEqual(['{"a":1}']);
    // The turn survives it — this is the whole point: before the fix the
    // string input replayed on the wire and the provider 400'd the round.
    expect(result.text).toBe("done");

    const messages = loop.getHistory().getMessages();
    const assistantWithTools = messages.find(
      (m) => m.role === "assistant" && Array.isArray((m as { toolCalls?: unknown[] }).toolCalls),
    ) as { toolCalls: Array<{ id: string; input: unknown }> } | undefined;
    expect(assistantWithTools).toBeDefined();
    // History stores an object for the malformed call, never the raw string.
    for (const tc of assistantWithTools!.toolCalls) {
      expect(typeof tc.input).toBe("object");
    }

    // Tool-pair invariant: every persisted tool_use still has a tool_result.
    const toolResults = messages.filter((m) => m.role === "tool_result") as Array<{
      toolUseId: string; content: string; isError?: boolean;
    }>;
    expect(toolResults.map((m) => m.toolUseId).sort()).toEqual(["tu-broken", "tu-good"]);
    const broken = toolResults.find((m) => m.toolUseId === "tu-broken")!;
    expect(broken.isError).toBe(true);
    expect(broken.content).toBe(
      t("be_conversationLoop.toolCallInvalidArguments", { excerpt: '{"command":"echo hel' }),
    );

    const invalidDecisions = decisions.filter((d) => d.kind === "tool_call.invalid_arguments");
    expect(invalidDecisions).toHaveLength(1);
    expect(invalidDecisions[0]!.branch).toBe("unparsable-json");
    expect(invalidDecisions[0]!.data?.tool).toBe("noop");
    expect(invalidDecisions[0]!.data?.rawChars).toBe(20);
  });

  it("contains truncated arguments end to end, from the raw provider part to the tool_result", async () => {
    // The test above hands the loop an event that already carries the marker.
    // This one starts where the defect actually starts — the AI SDK part whose
    // `input` is the raw argument text — and runs it through the real stream
    // mapper, so a regression anywhere along adapter → collector → loop is
    // caught rather than assumed away.
    const truncated = '{"command":"echo hel';
    const rounds: Array<Array<Record<string, unknown> & { type: string }>> = [
      [
        { type: "start" },
        { type: "tool-call", toolCallId: "tu-good", toolName: "noop", input: '{"a":1}' },
        { type: "tool-call", toolCallId: "tu-broken", toolName: "noop", input: truncated },
        { type: "finish", finishReason: "tool-calls" },
      ],
      [
        { type: "start" },
        { type: "text-delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop" },
      ],
    ];

    class AdapterBackedProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      private index = 0;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        const parts = rounds[this.index++] ?? [];
        async function* raw() {
          for (const part of parts) yield part;
        }
        yield* fullStreamToStreamEvent(raw());
      }
    }

    const executed: string[] = [];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "noop",
      description: "no-op tool",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (rawInput: unknown) => {
        executed.push(JSON.stringify(rawInput));
        return { output: "ok", isError: false };
      },
    }),
    );
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = new AdapterBackedProvider();

    const result = await loop.runTurn("call two tools", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    // The mapper parsed the good call's argument text; the broken one never ran.
    expect(executed).toEqual(['{"a":1}']);
    expect(result.text).toBe("done");

    const messages = loop.getHistory().getMessages();
    const toolResults = messages.filter((m) => m.role === "tool_result") as Array<{
      toolUseId: string; content: string; isError?: boolean;
    }>;
    expect(toolResults.map((m) => m.toolUseId).sort()).toEqual(["tu-broken", "tu-good"]);
    const broken = toolResults.find((m) => m.toolUseId === "tu-broken")!;
    expect(broken.isError).toBe(true);
    expect(broken.content).toBe(
      t("be_conversationLoop.toolCallInvalidArguments", { excerpt: truncated }),
    );

    // The raw string must not survive anywhere in the persisted assistant row —
    // that is the byte the provider rejects the whole next request over.
    const assistantWithTools = messages.find(
      (m) => m.role === "assistant" && Array.isArray((m as { toolCalls?: unknown[] }).toolCalls),
    ) as { toolCalls: Array<{ id: string; input: unknown }> } | undefined;
    expect(assistantWithTools).toBeDefined();
    for (const tc of assistantWithTools!.toolCalls) {
      expect(typeof tc.input).toBe("object");
    }
    expect(JSON.stringify(assistantWithTools!.toolCalls)).not.toContain(truncated);
  });

  it("lets the model read host-truncated tool_result chunks through the builtin chunk tool", async () => {
    const toolRegistry = new ToolRegistry();
    const longContent = Array.from(
      { length: 160 },
      (_, i) => `row-${i.toString().padStart(3, "0")}: ${"x".repeat(20)}`,
    ).join("\n");
    toolRegistry.register(
      createDynamicTool({
        name: "long_tool",
        description: "returns a long result",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: longContent, isError: false }),
      }),
    );
    toolRegistry.register(createReadToolResultChunkTool());

    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "long-1", name: "long_tool", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call",
          id: "chunk-1",
          name: "read_tool_result_chunk",
          input: { toolUseId: "long-1", chunkIndex: 0, maxChars: 500 },
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: {
        saveSession: () => {},
        listSessions: () => [],
      },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("call long tool then read chunk", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    const messages = loop.getHistory().getMessages();
    const longResult = messages.find(
      (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
        m.role === "tool_result" && m.toolUseId === "long-1",
    );
    expect(longResult?.meta?.truncated).toBeDefined();
    expect(longResult?.content).toBe(longContent);

    const chunkResult = messages.find(
      (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
        m.role === "tool_result" && m.toolUseId === "chunk-1",
    );
    expect(chunkResult?.isError).toBeUndefined();
    const parsed = JSON.parse(chunkResult!.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      toolUseId: "long-1",
      toolName: "long_tool",
      chunkIndex: 0,
      startChar: 0,
      endChar: 500,
      hasMore: true,
      chunk: longContent.slice(0, 500),
    });
  });

  it("reads host-truncated tool_result chunks from file-backed artifacts after session reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-loop-artifact-"));
    try {
      const sessionId = "fbff82d3-2ddc-4460-880d-961ce6e00e6a";
      const memoryManager = new MemoryManager({ lvisDir: dir });
      const longContent = Array.from(
        { length: 160 },
        (_, i) => `row-${i.toString().padStart(3, "0")}: ${"x".repeat(20)}`,
      ).join("\n");
      await memoryManager.saveSession(sessionId, [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "long-1", name: "long_tool", input: {} }],
        },
        {
          role: "tool_result",
          toolUseId: "long-1",
          toolName: "long_tool",
          content: longContent,
          meta: {
            truncated: {
              originalLines: 160,
              originalTokens: 1200,
              originalBytes: longContent.length,
              trimmedAt: "2026-05-19T00:00:00.000Z",
            },
          },
        },
      ] as GenericMessage[]);

      const toolRegistry = new ToolRegistry();
      toolRegistry.register(createReadToolResultChunkTool());
      const provider = new FakeProvider([
        [
          {
            type: "tool_call",
            id: "chunk-1",
            name: "read_tool_result_chunk",
            input: { toolUseId: "long-1", chunkIndex: 1, maxChars: 500 },
          },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ]);
      const loop = new ConversationLoop({
        settingsService: {
          get: () => fakeLlmSettings(),
          getSecret: () => "test-key",
        },
        systemPromptBuilder: {
          build: () => "system",
          setSummaryPreamble: vi.fn(),
        },
        inputClassifier: new InputClassifier(),
        routeEngine: new RouteEngine(),
        toolRegistry,
        memoryManager,
      } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
      (loop as { provider: LLMProvider | null }).provider = provider;

      expect(loop.loadSession(sessionId)).toBe(true);
      const reloaded = loop
        .getHistory()
        .getMessages()
        .find(
          (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
            m.role === "tool_result" && m.toolUseId === "long-1",
        );
      expect(reloaded?.content).toContain("[tool_result truncated by host");
      expect(reloaded?.meta?.truncated).toBeUndefined();

      await loop.runTurn("read chunk", undefined, undefined, {
        inputOrigin: "user-keyboard",
      });

      const chunkResult = loop
        .getHistory()
        .getMessages()
        .find(
          (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
            m.role === "tool_result" && m.toolUseId === "chunk-1",
        );
      expect(chunkResult?.isError).toBeUndefined();
      const parsed = JSON.parse(chunkResult!.content) as Record<
        string,
        unknown
      >;
      expect(parsed).toMatchObject({
        toolUseId: "long-1",
        toolName: "long_tool",
        chunkIndex: 1,
        startChar: 500,
        endChar: 1000,
        hasMore: true,
        chunk: longContent.slice(500, 1000),
      });
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  // ─── finish_reason=length CONTINUATION ──────────────────────────────────
  // A truncated round (stopReason "max_tokens") with 0 tool calls re-invokes
  // the model with a wire-only assistant prefill (vLLM continue_final_message),
  // stitching the partials into ONE merged assistant message. Continuation is
  // gated on the openai-compatible vendor; see vendorSupportsLengthContinuation.

  it("continues a max_tokens round and returns the stitched assistant text (openai-compatible)", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new RecordingPromptProvider([
      [
        { type: "text_delta", text: "Part one " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      [
        { type: "text_delta", text: "and part two." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn(
      "write a long answer",
      undefined,
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    // Did NOT terminate on the truncated round; stitched both parts.
    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toBe("Part one and part two.");
    // History holds exactly ONE assistant message with the merged content.
    const assistants = loop
      .getHistory()
      .getMessages()
      .filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as { content: string }).content).toBe(
      "Part one and part two.",
    );
    // The 2nd request injected a wire-only trailing assistant PREFILL = part one.
    const round2 = provider.messages[1];
    expect(round2.at(-1)).toEqual({ role: "assistant", content: "Part one " });
  });

  it.each(["codex", "kimi-code", "grok-build"] as const)(
    "does not stitch a %s subscription max_tokens response without a native prefill protocol",
    async (subscriptionProvider) => {
      const toolRegistry = new ToolRegistry();
      const provider = new SubscriptionRecordingPromptProvider([
        [
          { type: "text_delta", text: "Subscription part one " },
          { type: "message_complete", stopReason: "max_tokens" },
        ],
        // If the shared engine incorrectly continues, this synthetic second
        // round would expose the unsafe host-stitching regression.
        [
          { type: "text_delta", text: "and two." },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ], subscriptionProvider);
      const loop = new ConversationLoop({
        settingsService: {
          // A stale API-key setting that supports vLLM prefill must never
          // enable it for a subscription runtime.
          get: () => ({
            ...fakeLlmSettings({ provider: "openai-compatible" }),
            activeChatRuntime: { kind: "subscription", provider: subscriptionProvider },
          }),
          getSecret: () => "test-key",
        },
        systemPromptBuilder: { build: () => "system" },
        inputClassifier: new InputClassifier(),
        routeEngine: new RouteEngine(),
        toolRegistry,
        memoryManager: { saveSession: () => {}, listSessions: () => [] },
      } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
      (loop as { provider: LLMProvider | null }).provider = provider;

      const result = await loop.runTurn(
        "write a long answer",
        undefined,
        undefined,
        { inputOrigin: "user-keyboard" },
      );

      expect(result).toMatchObject({
        stopReason: "max_tokens",
        text: "Subscription part one",
      });
      expect(provider.params).toHaveLength(1);
      expect(provider.params[0]?.model).toBe("default");
      expect(provider.params[0]?.continuationPrefill).toBeUndefined();
    },
  );

  it("fires onAssistantRound exactly once (terminal) across a 2-round continued turn", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new RecordingPromptProvider([
      [
        { type: "text_delta", text: "Part one " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      [
        { type: "text_delta", text: "and part two." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const rounds: Array<{ text: string; stopReason: string }> = [];
    await loop.runTurn(
      "write a long answer",
      {
        onAssistantRound: ({ text, stopReason }) =>
          rounds.push({ text, stopReason }),
      },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    // The continuation round must NOT close the UI card — onAssistantRound
    // fires once, at the terminal round, with the merged text.
    expect(rounds).toEqual([
      { text: "Part one and part two.", stopReason: "end_turn" },
    ]);
  });

  it("caps runaway max_tokens continuations instead of looping forever", async () => {
    const toolRegistry = new ToolRegistry();
    let calls = 0;
    class InfiniteLengthProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text_delta", text: `chunk-${calls} ` };
        yield { type: "message_complete", stopReason: "max_tokens" };
      }
    }
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider =
      new InfiniteLengthProvider();

    const result = await loop.runTurn("runaway", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    // 1 initial round + MAX_LENGTH_CONTINUATIONS(3) = 4 provider calls, well under 30.
    expect(calls).toBe(4);
    expect(result.stopReason).toBe("max_tokens"); // residual truncation surfaced
    // Every chunk stitched with inter-chunk whitespace preserved (raw carry);
    // the final committed answer's trailing whitespace is trimmed once on merge.
    expect(result.text).toBe("chunk-1 chunk-2 chunk-3 chunk-4"); // every chunk stitched
  });

  it("does NOT continue a max_tokens round for a non-openai-compatible vendor", async () => {
    const toolRegistry = new ToolRegistry();
    let calls = 0;
    class CountingProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text_delta", text: "cut off" };
        yield { type: "message_complete", stopReason: "max_tokens" };
      }
    }
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai" }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider =
      new CountingProvider();

    const result = await loop.runTurn("x", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });
    expect(calls).toBe(1); // terminated immediately, no continuation
    expect(result.stopReason).toBe("max_tokens");
    expect(result.text).toBe("cut off");
  });

  it("continues truncation INSIDE <think> without losing or duplicating reasoning", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new RecordingPromptProvider([
      // Round 1: reasoning only, truncated mid-think (no text_delta, no </think>).
      [
        { type: "reasoning_delta", text: "step1 " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      // Round 2: finishes reasoning, then answers, clean end_turn.
      [
        { type: "reasoning_delta", text: "step2" },
        { type: "text_delta", text: "the answer" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn(
      "reason then answer",
      undefined,
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(result.text).toBe("the answer"); // answer only in result text
    // Round-2 prefill re-opened the think block with the accumulated reasoning, no closing tag.
    expect(provider.messages[1].at(-1)).toEqual({
      role: "assistant",
      content: "<think>\nstep1 ",
    });
    // History: ONE assistant message; reasoning concatenated, not duplicated.
    const assistant = loop
      .getHistory()
      .getMessages()
      .find((m) => m.role === "assistant") as {
      content: string;
      thought?: string;
    };
    expect(assistant.content).toBe("the answer");
    expect(assistant.thought).toBe("step1 step2");
  });

  // A resource attachment carries up to a read's worth of SERVER text. It has to reach
  // the model (that is the point) but it must not be replayed inside the user's own
  // transcript bubble, where it would read as something the user typed. `displayText`
  // is the seam the staged-origin work already established for that, and the marker the
  // user typed is what stands in for the body — exactly as an image's marker does.
  it("keeps an attached resource's body out of the user's transcript bubble", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn() },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const fence = [
      `${MCP_RESOURCE_FENCE_OPEN} server="hr-mcp" uri="file:///policy.md">`,
      "SERVER BODY THE USER DID NOT WRITE",
      "</mcp-resource>",
    ].join("\n");
    await loop.runTurn("summarize [Resource #1]", undefined, undefined, {
      inputOrigin: "user-keyboard",
      attachments: [{ type: "text", text: fence }],
    });

    const [firstMessage] = withoutRuntimeMeta(loop.getHistory().getMessages());
    // The model DOES receive it — the parts are intact.
    expect(firstMessage.content).toEqual([
      { type: "text", text: "summarize [Resource #1]" },
      { type: "text", text: fence },
    ]);
    // …and the transcript shows the user's own words only.
    const meta = (firstMessage as { meta?: { displayText?: string } }).meta;
    expect(meta?.displayText).toBe("summarize [Resource #1]");
    expect(meta?.displayText).not.toContain("SERVER BODY");
  });

  it("adds no displayText to a turn with no resource attachment", async () => {
    // The seam exists for server-authored parts. An ordinary turn must not acquire a
    // second copy of its own text in meta — that is what would make the two drift.
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn() },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("plain question", undefined, undefined, {
      inputOrigin: "user-keyboard",
      attachments: [{ type: "image", image: "data:image/png;base64,xx", mimeType: "image/png" }],
    });

    const [firstMessage] = withoutRuntimeMeta(loop.getHistory().getMessages());
    expect((firstMessage as { meta?: { displayText?: string } }).meta?.displayText)
      .toBeUndefined();
  });
});

describe("reasoning-only round is not a finished turn", () => {
  function createLoop(provider: LLMProvider): ConversationLoop {
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: new ToolRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;
    return loop;
  }

  const REASONING = "I need to retry the installation.";

  function reasoningOnlyRound(thought: string): StreamEvent[] {
    return [
      { type: "reasoning_delta", text: thought },
      { type: "message_complete", stopReason: "end_turn" },
    ];
  }

  it("re-prompts a round that ended with reasoning but no text and no tool call", async () => {
    // The measured shape: stopReason end_turn, empty visible text, no tool
    // call, and reasoning that names the next action. Ending there is the loop
    // giving up before the model did.
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(REASONING),
      [
        { type: "text_delta", text: "Reinstalled and verified." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);
    const decisions: TurnDecisionEvent[] = [];

    const result = await loop.runTurn(
      "install it",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(provider.messages).toHaveLength(2);
    expect(result.text).toBe("Reinstalled and verified.");
    expect(decisions).toContainEqual({
      kind: "reasoning_only.continuation",
      branch: "continue",
      data: { nudgesRun: 0, cap: 2, thoughtChars: REASONING.length },
    });
  });

  it("replays the reasoning as an assistant turn so the wire keeps role alternation", async () => {
    // The committed row carries the reasoning in `thought`, which no vendor
    // maps onto the wire, and it has neither text nor tool calls, so the
    // adapter drops it whole. Replaying the reasoning as the model's own prior
    // turn is what puts it in front of the model AND keeps user/assistant
    // alternation — a chat template that asserts alternation rejects the two
    // consecutive user rows a bare instruction would leave behind. Assert
    // against the REAL mapper, not the pre-adapter GenericMessage list.
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(REASONING),
      [
        { type: "text_delta", text: "Reinstalled." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);

    await loop.runTurn("install it", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    const wire = genericToModelMessages(provider.messages[1]!, "openai");
    expect(wire.map((message) => message.role)).toEqual([
      "user", "assistant", "user",
    ]);
    // The dropped empty row leaves no trace: every row carries real content.
    for (const message of wire) {
      expect(JSON.stringify(message.content)).not.toBe("[]");
    }
    expect(JSON.stringify(wire[1]!.content)).toContain(REASONING);
    expect(JSON.stringify(wire[2]!.content))
      .toContain(t("be_conversationLoop.reasoningOnlyContinuePrompt"));
  });

  it("replays only the tail of a long reasoning block", async () => {
    // A reasoning block ends on the action it decided; the earlier text is the
    // deliberation that led there. Bounding the replay keeps a runaway block
    // from pushing the round over the context budget it just came back under.
    const head = "H".repeat(5_000);
    const tail = " and finally I will run the installer.";
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(head + tail),
      [
        { type: "text_delta", text: "Ran it." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);

    await loop.runTurn("install it", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    const secondRound = provider.messages[1]!;
    const replay = secondRound[secondRound.length - 2]!;
    expect(replay.role).toBe("assistant");
    expect(replay.content).toContain(tail);
    expect(replay.content).not.toContain(head);
    expect(replay.content.length).toBe(2_000);
  });

  it("keeps the replay and the instruction on the wire only", async () => {
    const thought = "Let me verify the tokenizer.";
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(thought),
      [
        { type: "text_delta", text: "Verified." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);

    await loop.runTurn("check it", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    const secondRound = provider.messages[1]!;
    const [replay, instruction] = secondRound.slice(-2);
    expect(replay!.role).toBe("assistant");
    expect(replay!.content).toBe(thought);
    expect(instruction!.role).toBe("user");

    // The replay rewrites the row only for that request. History keeps the
    // committed shape — reasoning in `thought`, no assistant text — and never
    // takes the instruction, which would otherwise replay on every later turn
    // as if the user had typed it.
    const persisted = loop.getHistory().getMessages();
    expect(JSON.stringify(persisted)).not.toContain(instruction!.content);
    expect(persisted.filter((message) =>
      message.role === "assistant" && message.content === thought)).toEqual([]);
    expect(persisted.filter((message) =>
      message.role === "assistant" && message.thought === thought))
      .toHaveLength(1);
  });

  it("lets queued guidance win the end-turn boundary without spending the cap", async () => {
    // Guidance queued while the round ran is itself a re-prompt, and the
    // end-turn boundary hands the round to it before the reasoning-only branch
    // is reached. Nothing is armed, so nothing is spent: the NEXT reasoning-only
    // round still gets the full budget.
    const firstThought = "First thought.";
    const secondThought = "Second thought.";
    const provider = new RecordingPromptProvider([
      reasoningOnlyRound(firstThought),
      reasoningOnlyRound(secondThought),
      [
        { type: "text_delta", text: "Done." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider);
    const decisions: TurnDecisionEvent[] = [];
    // queueGuidance requires an in-flight turn; the loop sets this itself in
    // production, and the test stands in for the IPC thread that queues mid-turn.
    (loop as unknown as { currentAbortController: AbortController | null })
      .currentAbortController = new AbortController();
    loop.queueGuidance("use the other installer");

    await loop.runTurn(
      "install it",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const secondRoundText = JSON.stringify(provider.messages[1]!);
    expect(secondRoundText).toContain("use the other installer");
    // The replay is not tied to the re-prompt: the guide alone would have left
    // the dropped reasoning row collapsing its neighbours into two user turns.
    const guidedWire = genericToModelMessages(provider.messages[1]!, "openai");
    expect(guidedWire.map((message) => message.role)).toEqual([
      "user", "assistant", "user",
    ]);
    for (const message of guidedWire) {
      expect(JSON.stringify(message.content)).not.toBe("[]");
    }
    expect(JSON.stringify(guidedWire[1]!.content)).toContain(firstThought);
    // The first round's reasoning was never quoted into that round.
    expect(secondRoundText)
      .not.toContain(t("be_conversationLoop.reasoningOnlyContinuePrompt"));
    // Round 2 reasons only as well, and its re-prompt still reports 0 spent.
    expect(decisions.filter((event) =>
      event.kind === "reasoning_only.continuation")).toEqual([
      expect.objectContaining({
        branch: "continue",
        data: expect.objectContaining({
          nudgesRun: 0, thoughtChars: secondThought.length,
        }),
      }),
    ]);
    expect(JSON.stringify(provider.messages[2]!)).toContain(secondThought);
  });

  it("bounds the re-prompt so a model that only ever reasons still terminates", async () => {
    const thought = "still thinking";
    let calls = 0;
    class AlwaysReasoningProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "reasoning_delta", text: thought };
        yield { type: "message_complete", stopReason: "end_turn" };
      }
    }
    const loop = createLoop(new AlwaysReasoningProvider());
    const decisions: TurnDecisionEvent[] = [];

    const result = await loop.runTurn(
      "loop forever",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    // 1 initial round + 2 re-prompts, then the turn ends as it does today.
    expect(calls).toBe(3);
    expect(result.stopReason).toBe("end_turn");
    expect(
      decisions.filter(
        (event) => event.kind === "reasoning_only.continuation"
          && event.branch === "continue",
      ),
    ).toHaveLength(2);
    expect(decisions).toContainEqual({
      kind: "reasoning_only.continuation",
      branch: "stop",
      reason: "cap",
      data: { nudgesRun: 2, cap: 2, thoughtChars: thought.length },
    });
  });

  it("ends a genuinely empty round on the first attempt", async () => {
    let calls = 0;
    class EmptyProvider implements LLMProvider {
      readonly vendor = "openai" as const;
      async *streamTurn(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "message_complete", stopReason: "end_turn" };
      }
    }
    const loop = createLoop(new EmptyProvider());
    const decisions: TurnDecisionEvent[] = [];

    const result = await loop.runTurn(
      "nothing",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    // No reasoning means nothing states what the model meant to do next, so
    // there is nothing to re-prompt toward — unchanged behaviour.
    expect(calls).toBe(1);
    expect(result.text).toBe("");
    expect(
      decisions.filter((event) => event.kind === "reasoning_only.continuation"),
    ).toEqual([]);
  });
});

// ─── Output ceiling + progress notification ──────────────────────────────
//
// The two host-owned brakes on a runaway turn: a per-vendor output ceiling on
// each call, and a periodic notification telling the model what it has spent.

describe("ConversationLoop output ceiling", () => {
  it("forwards the active vendor's outputTokenLimit to every chat round", async () => {
    const provider = new RecordingPromptProvider([
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings({ outputTokenLimit: 16_384 }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: new ToolRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("answer", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.params[0]?.outputTokenLimit).toBe(16_384);
  });

  it("sends a chat ceiling above the background bound unclamped", async () => {
    // The background bound is sized for plugins. A user who configures a
    // larger chat ceiling used to get the plugin number silently instead.
    const provider = new RecordingPromptProvider([
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings({ outputTokenLimit: 32_768 }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: new ToolRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("answer", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.params[0]?.outputTokenLimit).toBe(32_768);
    expect(32_768).toBeGreaterThan(MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT);
  });

  it("sends no output ceiling when the vendor block declares none", async () => {
    const provider = new RecordingPromptProvider([
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: new ToolRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("answer", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.params[0]).not.toHaveProperty("outputTokenLimit");
  });

  // A host-capped call and a provider-capped one both come back as
  // stopReason "max_tokens", so the cap must not create a second truncation
  // path: the same length-continuation stitches the answer either way.
  it("continues a host-capped round through the same length-continuation path", async () => {
    const provider = new RecordingPromptProvider([
      [
        { type: "text_delta", text: "Part one " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      [
        { type: "text_delta", text: "and part two." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings({ provider: "openai-compatible", outputTokenLimit: 128 }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: new ToolRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: Array<{ kind: string; branch: string }> = [];
    const result = await loop.runTurn(
      "write a long answer",
      { onDecision: (event) => { decisions.push({ kind: event.kind, branch: event.branch }); } },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(result.text).toBe("Part one and part two.");
    expect(decisions).toContainEqual({ kind: "length.continuation", branch: "continue" });
    // The ceiling rode along on the continuation round too.
    expect(provider.params[1]?.outputTokenLimit).toBe(128);
  });
});

describe("ConversationLoop progress notification", () => {
  // The suite renders messages in Korean, so assertions match the first line
  // of the rendered notification rather than English prose.
  const NUDGE_HEADER = t("be_conversationLoop.progressNudge", {
    round: 0, elapsedSeconds: 0, toolCalls: 0, toolErrors: 0,
  }).split("\n")[0];

  /** Settings stub whose `chat` block carries a progress-notification cadence. */
  function settingsWithNudgeCadence(progressNudgeRounds: number) {
    return {
      get: (key: string) =>
        key === "chat"
          ? { ...DEFAULT_SETTINGS.chat, progressNudgeRounds }
          : fakeLlmSettings(),
      getSecret: () => "test-key",
    };
  }

  /** A tool-calling turn long enough to cross a cadence of 2. */
  function loopingProvider() {
    const round = (id: string): StreamEvent[] => [
      { type: "tool_call", id, name: "probe", input: {} },
      { type: "message_complete", stopReason: "tool_use" },
    ];
    return new RecordingPromptProvider([
      round("t1"),
      round("t2"),
      round("t3"),
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
  }

  function probeRegistry() {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "probe",
      description: "Probe",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }));
    return toolRegistry;
  }

  it("injects a wire-only notification on the cadence and records the decision", async () => {
    const provider = loopingProvider();
    const loop = new ConversationLoop({
      settingsService: settingsWithNudgeCadence(2),
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: probeRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: Array<{ kind: string; branch: string }> = [];
    await loop.runTurn(
      "keep working",
      { onDecision: (event) => { decisions.push({ kind: event.kind, branch: event.branch }); } },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(decisions).toContainEqual({ kind: "progress.nudge", branch: "cadence" });

    // Round index 2 is the first multiple of the cadence, so its request — and
    // no earlier one — ends with the notification.
    const lastOf = (index: number) => {
      const message = provider.messages[index]?.at(-1);
      return message && message.role === "user" ? String(message.content) : "";
    };
    expect(lastOf(2)).toContain(NUDGE_HEADER);
    expect(lastOf(0)).not.toContain(NUDGE_HEADER);
    expect(lastOf(1)).not.toContain(NUDGE_HEADER);

    // Wire-only: nothing about the notification reached the stored transcript.
    const stored = loop.getHistory().getMessages()
      .map((message) => String((message as { content?: unknown }).content ?? ""));
    expect(stored.some((content) => content.includes(NUDGE_HEADER))).toBe(false);
  });

  it("counts assistant rounds, not loop iterations, and skips continuation rounds", async () => {
    // The loop iterates for length continuations too, and `roundIndex` is
    // deliberately held across them. A cadence counting iterations drifts off
    // the assistant rounds the setting and the message both name: here it would
    // fall due on the continuation round, where the request has to end with the
    // assistant prefill, and be lost.
    const provider = new RecordingPromptProvider([
      // roundIndex 0 → 1: an ordinary tool round.
      [
        { type: "tool_call", id: "t1", name: "probe", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      // roundIndex stays 1: truncated with no tool calls, so it is continued.
      [
        { type: "text_delta", text: "Part one " },
        { type: "message_complete", stopReason: "max_tokens" },
      ],
      // The continuation. Tool calls end the chain, so roundIndex 1 → 2.
      [
        { type: "text_delta", text: "and part two." },
        { type: "tool_call", id: "t2", name: "probe", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: {
        get: (key: string) =>
          key === "chat"
            ? { ...DEFAULT_SETTINGS.chat, progressNudgeRounds: 2 }
            : fakeLlmSettings({ provider: "openai-compatible" }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: probeRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: Array<{ kind: string; branch: string }> = [];
    await loop.runTurn(
      "keep working",
      { onDecision: (event) => { decisions.push({ kind: event.kind, branch: event.branch }); } },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const last = (index: number) => provider.messages[index]?.at(-1);
    const lastContent = (index: number) =>
      String((last(index) as { content?: unknown } | undefined)?.content ?? "");

    // Request 2 is the continuation: it must still end with the prefill.
    expect(last(2)?.role).toBe("assistant");
    expect(lastContent(2)).not.toContain(NUDGE_HEADER);
    // Request 3 is the fourth iteration but only the third assistant round,
    // and it is where roundIndex reaches the cadence.
    expect(lastContent(3)).toContain(NUDGE_HEADER);
    expect(
      decisions.filter((decision) => decision.kind === "progress.nudge"),
    ).toEqual([{ kind: "progress.nudge", branch: "cadence" }]);
  });

  it("shares one user row with the reasoning re-prompt when both fire", async () => {
    // Two host instructions can fall on the same round. A chat template that
    // asserts role alternation rejects a second consecutive user row, so they
    // share the single appended row rather than each adding one.
    const thought = "I should check the tokenizer next.";
    const provider = new RecordingPromptProvider([
      // Reasoning with no text and no tool call: arms the re-prompt, and
      // advances roundIndex to 1, where a cadence of 1 also falls due.
      [
        { type: "reasoning_delta", text: thought },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop({
      settingsService: settingsWithNudgeCadence(1),
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: probeRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: string[] = [];
    await loop.runTurn(
      "check it",
      { onDecision: (event) => { decisions.push(event.kind); } },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const secondRound = provider.messages[1]!;
    // Exactly one appended user row, carrying both instructions.
    const trailingUserRows = [...secondRound]
      .reverse()
      .findIndex((message) => message.role !== "user");
    expect(trailingUserRows).toBe(1);
    const appended = secondRound.at(-1)!;
    expect(appended.role).toBe("user");
    // Not pinned to an elapsed-seconds value the clock decides: what matters is
    // that both instructions are in the one row, in order, blank-line joined.
    const rePrompt = t("be_conversationLoop.reasoningOnlyContinuePrompt");
    const appendedText = String(appended.content);
    expect(appendedText.startsWith(`${rePrompt}\n\n`)).toBe(true);
    expect(appendedText.slice(rePrompt.length + 2)).toContain(NUDGE_HEADER);
    // The reasoning replay still sits immediately before it.
    expect(secondRound.at(-2)!.role).toBe("assistant");
    expect(secondRound.at(-2)!.content).toBe(thought);
    expect(decisions).toContain("progress.nudge");
    expect(decisions).toContain("reasoning_only.continuation");

    // Neither instruction reached the transcript.
    expect(JSON.stringify(loop.getHistory().getMessages()))
      .not.toContain(NUDGE_HEADER);
  });

  it("injects nothing when the cadence is 0", async () => {
    const provider = loopingProvider();
    const loop = new ConversationLoop({
      settingsService: settingsWithNudgeCadence(0),
      systemPromptBuilder: { build: () => "system" },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry: probeRegistry(),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const decisions: string[] = [];
    await loop.runTurn(
      "keep working",
      { onDecision: (event) => { decisions.push(event.kind); } },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(decisions).not.toContain("progress.nudge");
    const anyNudge = provider.messages.some((round) =>
      round.some((message) => String((message as { content?: unknown }).content ?? "")
        .includes(NUDGE_HEADER)));
    expect(anyNudge).toBe(false);
  });
});
