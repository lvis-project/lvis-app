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

  // architecture.md §9.4a — host UI surface for plugin-owned auth.
  it("shows red dot on trigger when any plugin entry is unauthed", () => {
    const plugins: PluginEntry[] = [
      { viewKey: "plugin:a:v", label: "A", unauthed: false },
      { viewKey: "plugin:b:v", label: "B", unauthed: true },
    ];
    const { getByTestId } = renderButton(plugins);
    expect(getByTestId("plugin-grid-unauthed-dot")).toBeTruthy();
  });

  it("hides red dot when all entries are authed (or have no auth)", () => {
    const plugins: PluginEntry[] = [
      { viewKey: "plugin:a:v", label: "A", unauthed: false },
      { viewKey: "plugin:b:v", label: "B" }, // no auth declared
    ];
    const { queryByTestId } = renderButton(plugins);
    expect(queryByTestId("plugin-grid-unauthed-dot")).toBeNull();
  });

  it("renders 🔒 marker on individual unauthed grid entries", async () => {
    const user = userEvent.setup();
    const plugins: PluginEntry[] = [
      { viewKey: "plugin:a:v", label: "Authed", unauthed: false },
      { viewKey: "plugin:b:v", label: "Unauthed", unauthed: true },
    ];
    const { getByTestId } = renderButton(plugins);
    await act(async () => { await user.click(getByTestId("plugin-grid-button")); });
    // Popover renders into a portal — query the document, not the container.
    const unauthedBtn = document.querySelector('button[data-viewkey="plugin:b:v"]');
    expect(unauthedBtn?.getAttribute("data-unauthed")).toBe("true");
    const authedBtn = document.querySelector('button[data-viewkey="plugin:a:v"]');
    expect(authedBtn?.getAttribute("data-unauthed")).toBeNull();
  });
});
