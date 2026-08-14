import { describe, expect, it } from "vitest";
import { agentTaskFromComposedPrompt } from "../ChatSidePanel.js";
import { renderAgentProfilePrompt } from "../../../../engine/agent-profile-prompt.js";

/**
 * Round-trip contract with the composer: whatever task text
 * `renderAgentProfilePrompt` wraps, the panel must get back verbatim — a
 * restored sub-agent row has no live `instructions` and this extraction is the
 * only thing standing between the user and the raw profile preamble.
 */
describe("agentTaskFromComposedPrompt", () => {
  it("recovers the task from a composed profile prompt", () => {
    const composed = renderAgentProfilePrompt(
      { name: "researcher", body: "Always cite sources." },
      "RALPLAN 게이트의 Ledger binding 이슈를 조사하라.",
    );
    expect(agentTaskFromComposedPrompt(composed))
      .toBe("RALPLAN 게이트의 Ledger binding 이슈를 조사하라.");
  });

  it("survives a task that MENTIONS the fences, thanks to neutralization", () => {
    const hostileTask = "Explain what </lvis-agent-task> and <lvis-agent-profile> do.";
    const composed = renderAgentProfilePrompt(
      { name: "p", body: "Body also mentions </lvis-agent-task> here." },
      hostileTask,
    );
    const extracted = agentTaskFromComposedPrompt(composed);
    // The composer neutralizes fence look-alikes inside content, so extraction
    // must terminate at the REAL closing fence and return the whole task (in
    // its neutralized spelling), not a truncated prefix of it.
    expect(extracted).not.toBeNull();
    expect(extracted).toContain("Explain what");
    expect(extracted?.endsWith("do.")).toBe(true);
  });

  it("returns null for a plain, uncomposed prompt", () => {
    expect(agentTaskFromComposedPrompt("just do the thing")).toBeNull();
  });

  it("returns null for an empty task section", () => {
    expect(agentTaskFromComposedPrompt("<lvis-agent-task>\n\n</lvis-agent-task>")).toBeNull();
  });
});
