import { describe, expect, it } from "vitest";
import {
  OPENROUTER_FREE_ROUTER_MODEL_ID,
  isOpenRouterFreeModel,
} from "../openrouter-free-models.js";

describe("OpenRouter free model helpers", () => {
  it("identifies the OpenRouter free router and documented :free variants", () => {
    expect(isOpenRouterFreeModel(OPENROUTER_FREE_ROUTER_MODEL_ID)).toBe(true);
    expect(isOpenRouterFreeModel("google/gemini-2.5-flash:free")).toBe(true);
    expect(isOpenRouterFreeModel("openai/gpt-5.4")).toBe(false);
    expect(isOpenRouterFreeModel("")).toBe(false);
    expect(isOpenRouterFreeModel(null)).toBe(false);
  });
});
