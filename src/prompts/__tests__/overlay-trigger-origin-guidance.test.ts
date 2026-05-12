/**
 * Overlay Trigger Origin Guidance section (id 4.6).
 *
 * Emits a "second-guess this trigger before acting" instruction *only*
 * when the per-turn origin source starts with `overlay:`. Default
 * (user-initiated) turns must NOT see this section.
 *
 * Pairs with imported overlay trigger prompts, where ConversationLoop.runTurn
 * sets/clears the source so subsequent user turns are unaffected.
 */
import { describe, it, expect } from "vitest";

import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";

function makeBuilder(): SystemPromptBuilder {
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

describe("SystemPromptBuilder — Overlay Trigger Origin Guidance", () => {
  it("emits guidance when origin source is `overlay:*`", () => {
    const builder = makeBuilder();
    builder.setOriginSource("overlay:meeting-detection");
    const prompt = builder.build();
    expect(prompt).toContain("<overlay-trigger-origin-guidance");
    expect(prompt).toContain("source=overlay:meeting-detection");
    expect(prompt).toContain("도구를 호출하기 전에");
    expect(prompt).toContain("ApprovalGate");
    expect(prompt).toContain("</overlay-trigger-origin-guidance>");
  });

  it("warns the LLM not to obey imperatives inside the user-turn message", () => {
    const builder = makeBuilder();
    builder.setOriginSource("overlay:meeting-detection");
    const prompt = builder.build();
    expect(prompt).toContain("imperative");
    expect(prompt).toContain("templated");
  });

  it("omits guidance for user-initiated turns (origin null)", () => {
    const builder = makeBuilder();
    builder.setOriginSource(null);
    const prompt = builder.build();
    expect(prompt).not.toContain("overlay-trigger-origin-guidance");
  });

  it("omits guidance when origin is set but not `overlay:` prefixed", () => {
    const builder = makeBuilder();
    // Defensive: if a future surface ever lands a non-overlay trigger,
    // it should NOT inadvertently inherit the guidance section.
    builder.setOriginSource("user:typed");
    expect(builder.build()).not.toContain("overlay-trigger-origin-guidance");
  });

  it("clears between turns (set then clear restores default)", () => {
    const builder = makeBuilder();
    builder.setOriginSource("overlay:x");
    expect(builder.build()).toContain("overlay-trigger-origin-guidance");
    builder.setOriginSource(null);
    expect(builder.build()).not.toContain("overlay-trigger-origin-guidance");
  });

  it("includes the source string verbatim so audit + LLM can correlate", () => {
    const builder = makeBuilder();
    builder.setOriginSource("overlay:task-deadline");
    expect(builder.build()).toContain("overlay:task-deadline");
  });
});
