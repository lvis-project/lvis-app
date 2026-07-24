import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { SessionTodoStore } from "../../main/session-todo-store.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { SkillStore } from "../../main/skill-store.js";
import { createSkillLoadTool } from "../../tools/skill-load.js";

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

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.systemPrompts.push(input.systemPrompt);
    this.messages.push(input.messages);
    yield* this.turns[this.index++] ?? [];
  }
}

function withoutRuntimeMeta(messages: ReadonlyArray<GenericMessage>) {
  return messages.map((message) => {
    const { meta, ...rest } = message;
    if (!meta) return rest;
    const {
      createdAt: _createdAt,
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

  it("executes a pending completed-plan clear at the next turn start", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const sessionTodoStore = new SessionTodoStore();
    sessionTodoStore.write("s-main", [
      { content: "stale from previous turn", status: "completed" },
    ]);
    // The prior turn's post-turn hook marked this completed plan for clear.
    sessionTodoStore.markForClearIfCompleted("s-main");
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
      },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: {
        saveSession: () => {},
        listSessions: () => [],
      },
      sessionTodoStore,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;
    (loop as { sessionId: string }).sessionId = "s-main";

    await loop.runTurn("다음 질문", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    expect(sessionTodoStore.list("s-main")).toEqual([]);
  });

  it("executes a pending clear UNCONDITIONALLY for non-user-origin turns (no origin gate)", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const sessionTodoStore = new SessionTodoStore();
    sessionTodoStore.write("s-main", [
      { content: "completed user plan", status: "completed" },
    ]);
    // A prior turn marked the plan; the origin gate is gone, so even a
    // plugin-emitted (non-user-keyboard, non-queue-auto) turn must clear it.
    sessionTodoStore.markForClearIfCompleted("s-main");
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
      },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: {
        saveSession: () => {},
        listSessions: () => [],
      },
      sessionTodoStore,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;
    (loop as { sessionId: string }).sessionId = "s-main";

    await loop.runTurn("plugin prompt", undefined, undefined, { inputOrigin: "plugin-emitted",
    });

    expect(sessionTodoStore.list("s-main")).toEqual([]);
  });

  it("does not clear a completed plan mid-turn when no prior mark exists", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const sessionTodoStore = new SessionTodoStore();
    sessionTodoStore.write("s-main", [
      { content: "completed this very turn", status: "completed" },
    ]);
    // No markForClearIfCompleted yet — the plan was completed during a turn
    // whose post-turn hook hasn't run. It must stay visible until the NEXT
    // turn boundary, never cleared mid-turn.
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
      },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: {
        saveSession: () => {},
        listSessions: () => [],
      },
      sessionTodoStore,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;
    (loop as { sessionId: string }).sessionId = "s-main";

    await loop.runTurn("다음 질문", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    expect(sessionTodoStore.list("s-main").map((item) => item.content)).toEqual([
      "completed this very turn"],
    );
  });

  it("keeps unfinished session TO-DO plans across turn boundaries", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const sessionTodoStore = new SessionTodoStore();
    sessionTodoStore.write("s-main", [
      { content: "still running from previous turn", status: "in_progress" },
    ]);
    const loop = new ConversationLoop({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
      },
      inputClassifier: new InputClassifier(),
      routeEngine: new RouteEngine(),
      toolRegistry,
      memoryManager: {
        saveSession: () => {},
        listSessions: () => [],
      },
      sessionTodoStore,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;
    (loop as { sessionId: string }).sessionId = "s-main";

    await loop.runTurn("다음 질문", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    expect(sessionTodoStore.list("s-main").map((item) => item.content)).toEqual([
      "still running from previous turn"],
    );
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
        getApprovalGate: () => undefined,
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
      rmSync(dir, { recursive: true, force: true });
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
        getApprovalGate: () => undefined,
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
      rmSync(dir, { recursive: true, force: true });
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
    const rounds: Array<{ text: string; thought: string; stopReason: "end_turn" | "tool_use"; hasToolCalls: boolean;
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
        toolCalls: [{ id: "tool-1", name: "list_directory", input: { path: "src" } },
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
      const sessionId = "loop-artifact-session";
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
      rmSync(dir, { recursive: true, force: true });
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
});
