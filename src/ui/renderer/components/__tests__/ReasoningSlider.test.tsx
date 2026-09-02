// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { DEPTH_BUDGET, useReasoningLevel } from "../ReasoningSlider.js";
import { DEFAULT_LLM_VENDOR } from "../../../../shared/llm-vendor-defaults.js";

const getSettings = vi.fn();
const updateSettings = vi.fn();

vi.mock("../../api-client.js", () => ({
  getApi: () => ({ getSettings, updateSettings, onSettingsUpdated: () => () => {} }),
}));

describe("ReasoningSlider depth budget", () => {
  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    updateSettings.mockResolvedValue({ ok: true });
  });

  it("maps depth Low/Medium/High to 4k/10k/24k token budgets", () => {
    expect(DEPTH_BUDGET).toEqual({ low: 4_000, medium: 10_000, high: 24_000 });
  });

  it("reads a persisted high budget back as level 3", async () => {
    getSettings.mockResolvedValue({
      llm: { provider: DEFAULT_LLM_VENDOR, vendors: { [DEFAULT_LLM_VENDOR]: { thinkingBudgetTokens: DEPTH_BUDGET.high } } },
    });
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
    await waitFor(() => expect(result.current.level).toBe(3));
  });
});
