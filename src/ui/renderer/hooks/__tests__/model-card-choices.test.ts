import { describe, expect, it } from "vitest";
import { fakeLlmSettings } from "../../../../shared/__tests__/fake-llm-settings.js";
import { modelCardChoices } from "../use-settings.js";
import type { AppSettings } from "../../types.js";
import { fakeAppSettings } from "../../../../../test/renderer/fake-app-settings.js";

function llm(overrides: Partial<AppSettings["llm"]>): AppSettings["llm"] {
  return { ...fakeAppSettings({ llm: fakeLlmSettings({ provider: "openai", model: "gpt-5.4" }) }).llm, ...overrides };
}

describe("modelCardChoices", () => {
  it("keeps pinned order and drops a pin nothing offers", () => {
    const choices = modelCardChoices(llm({
      pinnedModels: ["nowhere", "gpt-5.4-mini", "gpt-5.4"],
    }));
    expect(choices.map((c) => c.modelId)).toEqual(["gpt-5.4-mini", "gpt-5.4"]);
  });

  it("leads with the current model when it is not pinned — even one no catalogue offers", () => {
    const choices = modelCardChoices(llm({ pinnedModels: ["gpt-5.4-mini"] }));
    expect(choices.map((c) => [c.modelId, c.current])).toEqual([["gpt-5.4", true], ["gpt-5.4-mini", false]]);
    const unlisted = modelCardChoices(llm({ pinnedModels: [], vendors: { openai: { model: "retired-model" } } as never }));
    expect(unlisted).toEqual([expect.objectContaining({ vendor: "openai", modelId: "retired-model", current: true })]);
  });

  it("resolves a pin through a synced catalogue to the vendor that serves it", () => {
    const choices = modelCardChoices(llm({
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
      expect.objectContaining({ vendor: "openai", modelId: "gpt-5.4", current: true }),
      expect.objectContaining({ vendor: "openai-compatible", modelId: "qwen3.8-27b-gguf", current: false }),
    ]);
  });

  it("marks the model the chat is on, and only under its own vendor", () => {
    const choices = modelCardChoices(llm({ pinnedModels: ["gpt-5.4"] }));
    expect(choices).toEqual([expect.objectContaining({ vendor: "openai", current: true })]);
  });

  it("is the current model alone with no pins", () => {
    expect(modelCardChoices(llm({ pinnedModels: [] }))).toEqual([expect.objectContaining({ modelId: "gpt-5.4", current: true })]);
    expect(modelCardChoices(llm({}))).toEqual([expect.objectContaining({ modelId: "gpt-5.4", current: true })]);
  });

  it("checks the subscription provider, not the API model it happens to share settings with, while a subscription runtime is active", () => {
    const choices = modelCardChoices(llm({
      pinnedModels: ["gpt-5.4"],
      activeChatRuntime: { kind: "subscription", provider: "codex", model: "gpt-5.1-codex" },
    }));
    expect(choices).toEqual([
      expect.objectContaining({ kind: "subscription", provider: "codex", vendorLabel: "Codex", modelId: "gpt-5.1-codex", current: true }),
      expect.objectContaining({ kind: "api", vendor: "openai", modelId: "gpt-5.4", current: false }),
    ]);
  });

  it("names the subscription provider alone when the runtime has no model of its own", () => {
    const choices = modelCardChoices(llm({
      pinnedModels: [],
      activeChatRuntime: { kind: "subscription", provider: "kimi-code" },
    }));
    expect(choices).toEqual([
      expect.objectContaining({ kind: "subscription", provider: "kimi-code", vendorLabel: "Kimi Code", modelId: null, current: true }),
    ]);
  });

  it("still checks the provider, and shows its raw id, for an unrecognised subscription id — never a borrowed descriptor", () => {
    const choices = modelCardChoices(llm({
      pinnedModels: ["gpt-5.4"],
      activeChatRuntime: { kind: "subscription", provider: "unknown-runtime" } as never,
    }));
    expect(choices).toEqual([
      // Not "Codex" — subscriptionRuntimeDescriptor's own fallback would
      // hand back its first entry for an id it does not recognise.
      expect.objectContaining({ kind: "subscription", provider: "unknown-runtime", vendorLabel: "unknown-runtime", modelId: null, current: true }),
      expect.objectContaining({ kind: "api", vendor: "openai", modelId: "gpt-5.4", current: false }),
    ]);
  });
});
