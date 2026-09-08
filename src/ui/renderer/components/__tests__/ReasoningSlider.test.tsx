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

  it("maps the five depths to their token budgets", () => {
    expect(DEPTH_BUDGET).toEqual({
      low: 4_000, medium: 10_000, high: 16_000, xhigh: 24_000, max: 32_000,
    });
  });

  it("keeps the ladder ascending, so a higher rung always thinks longer", () => {
    const budgets = Object.values(DEPTH_BUDGET);
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
  });

  it.each([
    ["low", 1], ["medium", 2], ["high", 3], ["xhigh", 4], ["max", 5],
  ] as const)("reads a persisted %s budget back as level %i", async (depth, level) => {
    getSettings.mockResolvedValue({
      llm: { provider: DEFAULT_LLM_VENDOR, vendors: { [DEFAULT_LLM_VENDOR]: { thinkingBudgetTokens: DEPTH_BUDGET[depth] } } },
    });
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
    await waitFor(() => expect(result.current.level).toBe(level));
  });

  it("offers a label for every rung, so no level renders as a blank", () => {
    getSettings.mockResolvedValue({
      llm: { provider: DEFAULT_LLM_VENDOR, vendors: { [DEFAULT_LLM_VENDOR]: {} } },
    });
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
    // One label per rung plus the off position the slider starts from.
    expect(result.current.levelLabels).toHaveLength(Object.keys(DEPTH_BUDGET).length + 1);
    expect(result.current.levelLabels.filter((l) => l.trim() !== "")).toHaveLength(6);
  });

  it("persists the budget of the rung the user picked, not the level index", async () => {
    getSettings.mockResolvedValue({
      llm: { provider: DEFAULT_LLM_VENDOR, vendors: { [DEFAULT_LLM_VENDOR]: {} } },
    });
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
    result.current.apply(5);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      llm: { vendors: { [DEFAULT_LLM_VENDOR]: { thinkingBudgetTokens: DEPTH_BUDGET.max } } },
    }));
  });

  it("clamps a level past the top rung instead of persisting an undefined budget", async () => {
    getSettings.mockResolvedValue({
      llm: { provider: DEFAULT_LLM_VENDOR, vendors: { [DEFAULT_LLM_VENDOR]: {} } },
    });
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
    result.current.apply(9);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      llm: { vendors: { [DEFAULT_LLM_VENDOR]: { thinkingBudgetTokens: DEPTH_BUDGET.max } } },
    }));
  });
});
