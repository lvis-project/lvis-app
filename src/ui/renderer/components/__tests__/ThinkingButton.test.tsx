// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ThinkingButton, DEPTH_BUDGET } from "../ThinkingButton.js";

const getSettings = vi.fn();
const updateSettings = vi.fn();

vi.mock("../../api-client.js", () => ({
  getApi: () => ({ getSettings, updateSettings }),
}));

function renderButton(overrides: Partial<Parameters<typeof ThinkingButton>[0]> = {}) {
  const props: Parameters<typeof ThinkingButton>[0] = {
    enabled: true,
    onToggle: vi.fn(),
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <ThinkingButton {...props} />
    </TooltipProvider>,
  );
}

describe("ThinkingButton", () => {
  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    getSettings.mockResolvedValue({
      llm: { provider: "azure-foundry", vendors: { "azure-foundry": { thinkingBudgetTokens: 10_000 } } },
    });
    updateSettings.mockResolvedValue({ ok: true });
  });

  it("maps depth Low/Medium/High to 4k/10k/24k token budgets", () => {
    expect(DEPTH_BUDGET).toEqual({ low: 4_000, medium: 10_000, high: 24_000 });
  });

  it("renders a thinking button reflecting the enabled state via aria-pressed", () => {
    const { getByTestId, rerender } = renderButton({ enabled: false });
    expect(getByTestId("thinking-button").getAttribute("aria-pressed")).toBe("false");
    rerender(
      <TooltipProvider>
        <ThinkingButton enabled onToggle={vi.fn()} />
      </TooltipProvider>,
    );
    expect(getByTestId("thinking-button").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens a popover with on/off toggle + Low/Medium/High depth", () => {
    const { getByTestId } = renderButton();
    fireEvent.click(getByTestId("thinking-button"));
    expect(getByTestId("thinking-popover")).toBeTruthy();
    expect(getByTestId("thinking-depth-low")).toBeTruthy();
    expect(getByTestId("thinking-depth-medium")).toBeTruthy();
    expect(getByTestId("thinking-depth-high")).toBeTruthy();
  });

  it("writes the active vendor's thinkingBudgetTokens when a depth is picked", async () => {
    const { getByTestId } = renderButton();
    fireEvent.click(getByTestId("thinking-button"));
    fireEvent.click(getByTestId("thinking-depth-high"));
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        llm: { vendors: { "azure-foundry": { thinkingBudgetTokens: 24_000 } } },
      });
    });
  });

  it("toggling the popover checkbox calls onToggle", () => {
    const onToggle = vi.fn();
    const { getByTestId, getByRole } = renderButton({ enabled: false, onToggle });
    fireEvent.click(getByTestId("thinking-button"));
    fireEvent.click(getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
