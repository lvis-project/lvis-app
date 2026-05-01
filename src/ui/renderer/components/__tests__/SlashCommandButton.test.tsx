// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { SlashCommandButton } from "../SlashCommandButton.js";

function renderButton(onInsert = vi.fn()) {
  return render(
    <TooltipProvider>
      <SlashCommandButton onInsert={onInsert} />
    </TooltipProvider>,
  );
}

const EXPECTED_COMMANDS = [
  "/new", "/sessions", "/load", "/compact",
  "/remember", "/memory", "/vendor", "/tools", "/help",
];

describe("SlashCommandButton", () => {
  it("renders trigger button with data-testid=slash-command-button", () => {
    const { getByTestId } = renderButton();
    expect(getByTestId("slash-command-button")).toBeTruthy();
  });

  it("opens popover on click showing all 9 slash commands", async () => {
    const user = userEvent.setup();
    const { getByTestId, getByRole } = renderButton();
    await act(async () => { await user.click(getByTestId("slash-command-button")); });
    // Popover content appears in document body portal
    const popover = document.querySelector("[data-testid='slash-command-popover']");
    expect(popover).toBeTruthy();
    for (const cmd of EXPECTED_COMMANDS) {
      const el = popover!.querySelector(`[data-cmd="${cmd}"]`);
      expect(el, `Expected button for ${cmd}`).toBeTruthy();
    }
    void getByRole; // suppress unused warning
  });

  it("has exactly 9 commands", async () => {
    const user = userEvent.setup();
    const { getByTestId } = renderButton();
    await act(async () => { await user.click(getByTestId("slash-command-button")); });
    const popover = document.querySelector("[data-testid='slash-command-popover']");
    expect(popover).toBeTruthy();
    const buttons = popover!.querySelectorAll("[data-cmd]");
    expect(buttons).toHaveLength(9);
  });

  it("calls onInsert with command string when item clicked", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    const { getByTestId } = renderButton(onInsert);
    await act(async () => { await user.click(getByTestId("slash-command-button")); });
    const helpBtn = document.querySelector("[data-cmd='/help']") as HTMLElement | null;
    expect(helpBtn).toBeTruthy();
    await act(async () => { await user.click(helpBtn!); });
    expect(onInsert).toHaveBeenCalledWith("/help");
  });
});
