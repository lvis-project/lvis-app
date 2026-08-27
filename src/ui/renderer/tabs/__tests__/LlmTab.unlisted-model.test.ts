import { describe, expect, it } from "vitest";
import { unlistedSavedModel } from "../LlmTab.js";

describe("unlistedSavedModel", () => {
  const catalogue = ["qwen3.8-27b-gguf", "qwen3.8-27b-nvfp4", "all-proxy-models"];

  it("names a saved model the endpoint no longer lists", () => {
    expect(unlistedSavedModel("qwen3.8-27b", catalogue)).toBe("qwen3.8-27b");
  });

  it("is quiet while the saved model is still served", () => {
    expect(unlistedSavedModel("qwen3.8-27b-gguf", catalogue)).toBeNull();
  });

  it("has nothing to say before a catalogue has landed", () => {
    expect(unlistedSavedModel("qwen3.8-27b", undefined)).toBeNull();
    expect(unlistedSavedModel("qwen3.8-27b", [])).toBeNull();
  });

  it("ignores an empty selection", () => {
    expect(unlistedSavedModel("  ", catalogue)).toBeNull();
  });
});
