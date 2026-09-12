// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useReasoningLevel } from "../ReasoningSlider.js";
import { getReasoningDepths, budgetToDepthIndex } from "../../constants.js";
import { DEFAULT_LLM_VENDOR, getLlmVendorSettings } from "../../../../shared/llm-vendor-defaults.js";

const getSettings = vi.fn();
const updateSettings = vi.fn();
const onSettingsUpdated = vi.fn();

vi.mock("../../api-client.js", () => ({
  getApi: () => ({ getSettings, updateSettings, onSettingsUpdated }),
}));

function settings(thinkingBudgetTokens = 8_000, outputTokenLimit = 32_000) {
  return {
    llm: {
      provider: DEFAULT_LLM_VENDOR,
      vendors: { [DEFAULT_LLM_VENDOR]: {
        ...getLlmVendorSettings(undefined, DEFAULT_LLM_VENDOR), thinkingBudgetTokens, outputTokenLimit,
      } },
    },
  };
}

describe("ReasoningSlider depth budget", () => {
  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    onSettingsUpdated.mockReset();
    onSettingsUpdated.mockReturnValue(() => {});
    updateSettings.mockResolvedValue({ ok: true });
  });

  it("resolves a budget between the current rungs to the nearest label", () => {
    const depths = getReasoningDepths(32_000);
    expect(depths[budgetToDepthIndex(11_000, depths)]!.key).toBe("medium");
    expect(depths[budgetToDepthIndex(2_000, depths)]!.key).toBe("low");
    expect(depths[budgetToDepthIndex(999_999, depths)]!.key).toBe("high");
  });

  it.each([
    [4_000, 1], [8_000, 2], [16_000, 3],
  ])("reads persisted budget %i back as level %i", async (budget, level) => {
    getSettings.mockResolvedValue(settings(budget));
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
    await waitFor(() => expect(result.current.level).toBe(level));
    expect(result.current.levelLabels).toHaveLength(4);
    expect(result.current.levelLabels.every((label) => label.trim() !== "")).toBe(true);
  });

  it.each([32_000, 16_000, 64_000])(
    "persists every distinct offered rung and keeps its level after broadcast with output %i", async (outputTokenLimit) => {
      let current = settings(10_000, outputTokenLimit);
      getSettings.mockImplementation(async () => current);
      updateSettings.mockImplementation(async (patch) => {
        const block = getLlmVendorSettings({ [DEFAULT_LLM_VENDOR]: {
          ...current.llm.vendors[DEFAULT_LLM_VENDOR],
          ...patch.llm.vendors[DEFAULT_LLM_VENDOR],
        } }, DEFAULT_LLM_VENDOR);
        current = settings(block.thinkingBudgetTokens, outputTokenLimit);
        onSettingsUpdated.mock.calls[0]![0](current);
        return { ok: true };
      });
      const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
      await act(async () => {});
      const expected = outputTokenLimit === 32_000 ? [4_000, 8_000, 16_000]
        : outputTokenLimit === 16_000 ? [4_000, 8_000]
          : [4_000, 8_000, 16_000, 32_000];
      expect(result.current.levelLabels).toHaveLength(expected.length + 1);
      for (const [index, budget] of expected.entries()) {
        await act(async () => result.current.apply(index + 1));
        await waitFor(() => expect(result.current.level).toBe(index + 1));
        expect(updateSettings).toHaveBeenLastCalledWith({
          llm: { vendors: { [DEFAULT_LLM_VENDOR]: { thinkingBudgetTokens: budget } } },
        });
      }
    },
  );

  it("uses a changed output limit before persisting a choice", async () => {
    getSettings.mockResolvedValue(settings(14_000));
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
    await waitFor(() => expect(result.current.level).toBe(3));
    getSettings.mockResolvedValue(settings(8_000, 16_000));
    await act(async () => result.current.apply(3));
    expect(updateSettings).toHaveBeenLastCalledWith({
      llm: { vendors: { [DEFAULT_LLM_VENDOR]: { thinkingBudgetTokens: 8_000 } } },
    });
    await act(async () => onSettingsUpdated.mock.calls[0]![0](settings(8_000, 16_000)));
    expect(result.current.level).toBe(2);
  });

  it("clamps legacy oversized budgets and out-of-range levels to the upper rung", async () => {
    getSettings.mockResolvedValue(settings(32_000));
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
    await waitFor(() => expect(result.current.level).toBe(3));
    await act(async () => result.current.apply(9));
    expect(updateSettings).toHaveBeenLastCalledWith({
      llm: { vendors: { [DEFAULT_LLM_VENDOR]: { thinkingBudgetTokens: 16_000 } } },
    });
  });

  it.each([10_000, 14_000])("preserves custom budget %i on initial read and broadcasts", async (budget) => {
    getSettings.mockResolvedValue(settings(budget));
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle: () => {} }));
    await waitFor(() => expect(result.current.custom).toBe(true));
    expect(result.current.currentLabel).toContain(budget.toLocaleString("en-US"));
    await act(async () => onSettingsUpdated.mock.calls[0]![0](settings(budget)));
    expect(result.current.currentLabel).toContain(budget.toLocaleString("en-US"));
    expect(updateSettings).not.toHaveBeenCalled();
    await act(async () => result.current.apply(3));
    expect(updateSettings).toHaveBeenLastCalledWith({
      llm: { vendors: { [DEFAULT_LLM_VENDOR]: { thinkingBudgetTokens: 16_000 } } },
    });
  });

  it("keeps a tiny custom budget when no preset fits and keeps off separate", async () => {
    getSettings.mockResolvedValue(settings(2, 4));
    const onToggle = vi.fn();
    const { result } = renderHook(() => useReasoningLevel({ enabled: true, onToggle }));
    await waitFor(() => expect(result.current.levelLabels).toHaveLength(2));
    expect(result.current.currentLabel).toContain("2");
    await act(async () => result.current.apply(9));
    expect(updateSettings).not.toHaveBeenCalled();
    await act(async () => result.current.apply(0));
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(updateSettings).not.toHaveBeenCalled();
    await act(async () => onSettingsUpdated.mock.calls[0]![0](settings(0, 1)));
    expect(result.current.levelLabels).toHaveLength(2);
    expect(result.current.level).toBe(1);
    expect(result.current.currentLabel).toContain("0");
  });
});
