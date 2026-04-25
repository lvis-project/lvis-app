/**
 * P0 — Proactive Origin Guidance section (id 4.6).
 *
 * Emits a "second-guess this trigger before acting" instruction *only*
 * when the per-turn origin source starts with `proactive:`. Default
 * (user-initiated) turns must NOT see this section.
 *
 * Pairs with ConversationLoop.runTriggerTurn which sets/clears the source
 * around the delegated runTurn so subsequent user turns are unaffected.
 */
import { describe, it, expect } from "vitest";

import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";

function makeBuilder(): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: {
      getLvisMd: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: new ToolRegistry(),
  });
}

describe("SystemPromptBuilder — Proactive Origin Guidance", () => {
  it("emits guidance when origin source is `proactive:*`", () => {
    const builder = makeBuilder();
    builder.setOriginSource("proactive:meeting-detection");
    const prompt = builder.build();
    expect(prompt).toContain("<proactive-origin-guidance");
    expect(prompt).toContain("source=proactive:meeting-detection");
    expect(prompt).toContain("도구를 호출하기 전에");
    expect(prompt).toContain("ApprovalGate");
    expect(prompt).toContain("</proactive-origin-guidance>");
  });

  it("warns the LLM not to obey imperatives inside the user-turn message (PR #215 review H3)", () => {
    const builder = makeBuilder();
    builder.setOriginSource("proactive:meeting-detection");
    const prompt = builder.build();
    expect(prompt).toContain("imperative");
    expect(prompt).toContain("templated");
  });

  it("omits guidance for user-initiated turns (origin null)", () => {
    const builder = makeBuilder();
    builder.setOriginSource(null);
    const prompt = builder.build();
    expect(prompt).not.toContain("proactive-origin-guidance");
  });

  it("omits guidance when origin is set but not `proactive:` prefixed", () => {
    const builder = makeBuilder();
    // Defensive: if a future surface ever lands a non-proactive trigger,
    // it should NOT inadvertently inherit the guidance section.
    builder.setOriginSource("user:typed");
    expect(builder.build()).not.toContain("proactive-origin-guidance");
  });

  it("clears between turns (set then clear restores default)", () => {
    const builder = makeBuilder();
    builder.setOriginSource("proactive:x");
    expect(builder.build()).toContain("proactive-origin-guidance");
    builder.setOriginSource(null);
    expect(builder.build()).not.toContain("proactive-origin-guidance");
  });

  it("includes the source string verbatim so audit + LLM can correlate", () => {
    const builder = makeBuilder();
    builder.setOriginSource("proactive:task-deadline");
    expect(builder.build()).toContain("proactive:task-deadline");
  });
});
