import { vi } from "vitest";

import type { PromptMemorySource } from "../../memory/memory-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { SystemPromptBuilder } from "../system-prompt-builder.js";

/**
 * A complete {@link PromptMemorySource} double. Every member the builder calls
 * is required, so a test supplies only the readers its assertion is about and
 * inherits empty-but-real values for the rest.
 */
export function makePromptMemorySource(
  overrides: Partial<PromptMemorySource> = {},
): PromptMemorySource {
  return {
    getAgentsMd: vi.fn(() => ""),
    getAgentsCustomMd: vi.fn(() => ""),
    getProjectAgentsMd: vi.fn((projectRoot: string) => ({ projectRoot, layers: [], totalBytes: 0 })),
    getPromptUserPreferences: vi.fn(() => ""),
    getPromptMemoryIndex: vi.fn(() => ""),
    getPromptLongTermMemoryOverview: vi.fn(() => ""),
    selectRelevantMemories: vi.fn(() => ({ entries: [], context: "", usedTokens: 0 })),
    ...overrides,
  };
}

export function makeSystemPromptBuilder(): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: makePromptMemorySource(),
    toolRegistry: new ToolRegistry(),
  });
}
