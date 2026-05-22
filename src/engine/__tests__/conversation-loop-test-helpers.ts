import { vi } from "vitest";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import type { ConversationLoopDeps } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";

export function makeConversationLoopSettings(
  autoCompact = true,
  model = "claude-sonnet-4-5",
  provider: "openai" | "claude" | "gemini" | "copilot" | "azure-foundry" | "vertex-ai" = "claude",
): ConversationLoopDeps["settingsService"] {
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

export function makeConversationLoopMemoryManager(
  messages: GenericMessage[] | null = [],
  sessionId = "sess-1",
): ConversationLoopDeps["memoryManager"] {
  const sessions: Record<string, GenericMessage[]> = messages === null ? {} : { [sessionId]: messages };
  return {
    listSessions: () => Object.keys(sessions).map((id) => ({ id, modifiedAt: new Date() })),
    loadSession: (id: string) => sessions[id] ?? null,
    loadSessionMetadata: vi.fn(() => null),
    saveSession: vi.fn((id: string, msgs: GenericMessage[]) => {
      sessions[id] = msgs;
    }),
    saveSessionMetadata: vi.fn(),
    appendCheckpoint: vi.fn((_meta: unknown, cp: unknown) => ({ checkpoints: [cp] })),
    saveCheckpointSnapshot: vi.fn(),
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

export function makeConversationLoopLongHistory(count = 20): GenericMessage[] {
  const messages: GenericMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i} ${"x".repeat(200)}`,
    });
  }
  return messages;
}

export function makeConversationLoopDeps(
  overrides: Partial<ConversationLoopDeps> = {},
): ConversationLoopDeps {
  return {
    settingsService: makeConversationLoopSettings(),
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: vi.fn(),
      setOriginSource: vi.fn(),
      setActiveSessionId: vi.fn(),
      setActiveRolePrompt: vi.fn(),
    } as unknown as ConversationLoopDeps["systemPromptBuilder"],
    keywordEngine: {
      classify: vi.fn().mockReturnValue({ type: "chat" }),
      matchAllPluginIds: () => new Set(),
    } as unknown as ConversationLoopDeps["keywordEngine"],
    routeEngine: {
      route: vi.fn().mockReturnValue({ route: "llm" }),
    } as unknown as ConversationLoopDeps["routeEngine"],
    toolRegistry: {
      getToolSchemasForScope: () => [],
      getVisibleTools: () => [],
    } as unknown as ConversationLoopDeps["toolRegistry"],
    memoryManager: makeConversationLoopMemoryManager(),
    ...overrides,
  };
}

export function makeConversationTurnProvider() {
  return {
    vendor: "claude" as const,
    streamTurn: async function* () {
      yield { type: "text_delta" as const, text: "ok" };
      yield { type: "message_complete" as const };
    },
  };
}
