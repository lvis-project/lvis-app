import { ToolRegistry } from "../../tools/registry.js";
import { SystemPromptBuilder } from "../system-prompt-builder.js";

export function makeSystemPromptBuilder(): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: {
      getAgentsMd: () => "",
      getLvisMd: () => "",
      getMemoryIndex: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: new ToolRegistry(),
  });
}
