import { describe, expect, it } from "vitest";
import { t } from "../../i18n/runtime.js";
import { ToolRegistry } from "../../tools/registry.js";
import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { makePromptMemorySource } from "./test-helpers.js";

describe("system prompt shell environment", () => {
  it("provides shell environment separately from the storage home and keeps operation status guidance", () => {
    const prompt = new SystemPromptBuilder({
      memoryManager: makePromptMemorySource(),
      toolRegistry: new ToolRegistry(),
    }).build();
    expect(prompt).toContain("Application paths (JSON):");
    expect(prompt).toContain("<shell-execution-environment>");
    expect(prompt).toContain(t("shellExecution.currentUser"));
    expect(prompt).toContain(t("shellExecution.pipelineStatus"));
    expect(prompt.match(/<shell-execution-environment>/g)).toHaveLength(1);
  });
});
