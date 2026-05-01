// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { PluginGridButton } from "../PluginGridButton.js";
import type { PluginEntry } from "../PluginGridButton.js";

function makePlugins(n: number): PluginEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    viewKey: `plugin:test:ext${i}`,
    label: `Plugin ${i}`,
    icon: "🔌",
  }));
}

function renderButton(plugins: PluginEntry[], onSelect = vi.fn()) {
  return render(
    <TooltipProvider>
      <PluginGridButton plugins={plugins} onSelect={onSelect} />
    </TooltipProvider>,
  );
}

describe("PluginGridButton", () => {
  it("renders trigger button with data-testid=plugin-grid-button", () => {
    const { getByTestId } = renderButton([]);
    expect(getByTestId("plugin-grid-button")).toBeTruthy();
  });

  it("shows Popover (not Dialog) when fewer than 5 plugins", async () => {
    const user = userEvent.setup();
    const plugins = makePlugins(3);
    const { getByTestId, getByText } = renderButton(plugins);
    await act(async () => { await user.click(getByTestId("plugin-grid-button")); });
    expect(getByText("Plugin 0")).toBeTruthy();
    expect(document.querySelector("[data-testid='plugin-grid']")).toBeTruthy();
  });

  it("shows Dialog when 5 or more plugins", async () => {
    const user = userEvent.setup();
    const plugins = makePlugins(5);
    const { getByTestId, getByText } = renderButton(plugins);
    await act(async () => { await user.click(getByTestId("plugin-grid-button")); });
    // Dialog header title appears
    expect(getByText("플러그인")).toBeTruthy();
  });

  it("calls onSelect with correct viewKey when cell clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const plugins = makePlugins(2);
    const { getByTestId, getByText } = renderButton(plugins, onSelect);
    await act(async () => { await user.click(getByTestId("plugin-grid-button")); });
    expect(getByText("Plugin 0")).toBeTruthy();
    await act(async () => { await user.click(getByText("Plugin 0")); });
    expect(onSelect).toHaveBeenCalledWith("plugin:test:ext0");
  });
});
