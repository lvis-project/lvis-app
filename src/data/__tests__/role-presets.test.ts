import { describe, it, expect } from "vitest";
import { DEFAULT_PERSONA_SELECTION, buildActivePersonaPromptId } from "../role-presets.js";

describe("role-presets", () => {
  it("keeps the synthetic default persona as no role prompt", () => {
    expect(DEFAULT_PERSONA_SELECTION).toEqual({
      id: "default",
      name: "기본",
      systemPromptAdd: "",
      isDefault: true,
    });
    expect(buildActivePersonaPromptId(DEFAULT_PERSONA_SELECTION)).toBeNull();
    expect(buildActivePersonaPromptId(null)).toBeNull();
  });

  it("non-default persona builds only the prompt-store id for chat IPC", () => {
    const payload = buildActivePersonaPromptId({
      id: "summarizer",
      name: "요약가",
      systemPromptAdd: "Act as a professional summarizer.",
    });
    expect(payload).toBe("summarizer");
  });
});
