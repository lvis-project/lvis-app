// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { DEPTH_BUDGET, useReasoningLevel } from "../ReasoningSlider.js";
import { REASONING_DEPTHS, budgetToDepthIndex } from "../../constants.js";
import { readRepoFile } from "../../../../__tests__/test-helpers.js";
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

  it("is the same ladder the settings tab writes, not a second copy", () => {
    // The composer and the settings tab both persist `thinkingBudgetTokens` on
    // the same vendor. When each carried its own budgets they disagreed about
    // what a stored number meant: settings wrote 12,000 for "High" and the
    // composer showed "Medium", because 12,000 was nearest its own 10,000
    // rung. One ladder is the fix; this asserts the settings tab still reads
    // it rather than growing new numbers of its own.
    expect(DEPTH_BUDGET).toEqual(
      Object.fromEntries(REASONING_DEPTHS.map((d) => [d.key, d.budget])),
    );
    const settingsTab = readRepoFile("src/ui/renderer/tabs/LlmTab.tsx");
    expect(settingsTab).toContain("REASONING_DEPTHS");
    expect(settingsTab).toContain("budgetToDepthIndex");
    expect(settingsTab).not.toMatch(/budget:\s*[\d_]+/u);
  });

  it("resolves a budget that sits between rungs to the nearest one", () => {
    // Anything already persisted has to land somewhere -- including the
    // 12,000 the old settings ladder wrote, and the 2,000 below its bottom.
    // 12,000 is 2,000 from medium and 4,000 from high, so it lands on medium --
    // which is what the composer already showed for it. The two surfaces now
    // agree on that instead of only one of them being right.
    expect(REASONING_DEPTHS[budgetToDepthIndex(12_000)]!.key).toBe("medium");
    expect(REASONING_DEPTHS[budgetToDepthIndex(2_000)]!.key).toBe("low");
    expect(REASONING_DEPTHS[budgetToDepthIndex(999_999)]!.key).toBe("max");
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
