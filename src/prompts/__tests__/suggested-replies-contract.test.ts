/**
 * Contract test — verify the suggested-replies instruction is always
 * included in the assembled system prompt.
 *
 * If a future refactor reorders or gates the source, the renderer will
 * silently stop receiving suggestions. This test catches that regression
 * before it ships.
 */
import { describe, it, expect } from "vitest";
import { SUGGESTED_REPLIES_OPEN, SUGGESTED_REPLIES_CLOSE } from "../../engine/suggested-replies.js";
import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";

function buildMinimalPrompt(): string {
  const builder = new SystemPromptBuilder({
    memoryManager: {
      getAgentsMd: () => "",
      getLvisMd: () => "",
      getMemoryIndex: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: new ToolRegistry(),
    getPluginCards: () => [],
  });
  return builder.build();
}

describe("system prompt — suggested replies contract", () => {
  it("includes the Suggested Replies instruction section", () => {
    const prompt = buildMinimalPrompt();
    expect(prompt).toContain("## Suggested Replies");
  });

  it("includes the exact open/close tags so parser/filter stays in sync", () => {
    const prompt = buildMinimalPrompt();
    expect(prompt).toContain(SUGGESTED_REPLIES_OPEN);
    expect(prompt).toContain(SUGGESTED_REPLIES_CLOSE);
  });

  it("instructs the model to omit the block when no follow-up is natural", () => {
    const prompt = buildMinimalPrompt();
    // The renderer counts on the model NOT padding every turn with junk
    // suggestions. The prompt must preserve the explicit "생략한다" guidance.
    expect(prompt).toMatch(/생략한다/);
  });

  it("keeps the #980 count and command-prefix policy explicit", () => {
    const prompt = buildMinimalPrompt();
    expect(prompt).toContain("기본 3개");
    expect(prompt).toContain("최대 5개");
    expect(prompt).toContain("완결 답변");
    expect(prompt).toContain("/clear 포함");
    expect(prompt).toContain("단일 토큰 command 도 금지");
    const example = prompt.slice(
      prompt.indexOf(SUGGESTED_REPLIES_OPEN),
      prompt.indexOf(SUGGESTED_REPLIES_CLOSE),
    );
    expect(example.match(/^- \{text\}$/gm)).toHaveLength(3);
  });
});
