import { describe, expect, it } from "vitest";
import { fakeLlmSettings } from "../../../../shared/__tests__/fake-llm-settings.js";
import { pinnedModelChoices } from "../use-settings.js";
import type { AppSettings } from "../../types.js";

function llm(overrides: Partial<AppSettings["llm"]>): AppSettings["llm"] {
  return { ...(fakeLlmSettings({ provider: "openai", model: "gpt-5.4" }) as AppSettings["llm"]), ...overrides };
}

describe("pinnedModelChoices", () => {
  it("keeps pinned order and drops a pin nothing offers", () => {
    const choices = pinnedModelChoices(llm({
      pinnedModels: ["nowhere", "gpt-5.4-mini", "gpt-5.4"],
    }));
    expect(choices.map((c) => c.modelId)).toEqual(["gpt-5.4-mini", "gpt-5.4"]);
  });

  it("resolves a pin through a synced catalogue to the vendor that serves it", () => {
    const choices = pinnedModelChoices(llm({
      pinnedModels: ["qwen3.8-27b-gguf"],
      modelListCache: {
        "openai-compatible\nhttp://llm.example.test/v1\n": {
          vendor: "openai-compatible",
          baseUrl: "http://llm.example.test/v1",
          endpoint: "http://llm.example.test/v1/models",
          models: ["qwen3.8-27b-gguf"],
          fetchedAt: "2026-08-27T00:00:00.000Z",
        },
      },
    }));
    expect(choices).toEqual([
      expect.objectContaining({ vendor: "openai-compatible", modelId: "qwen3.8-27b-gguf", current: false }),
    ]);
  });

  it("marks the model the chat is on, and only under its own vendor", () => {
    const choices = pinnedModelChoices(llm({ pinnedModels: ["gpt-5.4"] }));
    expect(choices).toEqual([expect.objectContaining({ vendor: "openai", current: true })]);
  });

  it("is empty with no pins", () => {
    expect(pinnedModelChoices(llm({ pinnedModels: [] }))).toEqual([]);
    expect(pinnedModelChoices(llm({}))).toEqual([]);
  });
});
