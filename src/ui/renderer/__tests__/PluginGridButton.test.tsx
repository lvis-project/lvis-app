import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { PluginGridButton, type PluginEntry } from "../components/PluginGridButton.js";

function makePlugins(count: number): PluginEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    viewKey: `plugin:test-${i}:main`,
    label: `Plugin ${i}`,
    icon: i === 0 ? "Mic" : undefined,
  }));
}

function renderGrid(
  plugins: PluginEntry[],
  opts: {
    installingPluginIds?: Set<string>;
    onSelect?: (k: string) => void;
    onOpenMarketplace?: () => void;
  } = {},
) {
  const onSelect = opts.onSelect ?? vi.fn();
  const onOpenMarketplace = opts.onOpenMarketplace ?? vi.fn();
  const result = render(
    <TooltipProvider>
      <PluginGridButton
        plugins={plugins}
        installingPluginIds={opts.installingPluginIds}
        onSelect={onSelect}
        onOpenMarketplace={onOpenMarketplace}
      />
    </TooltipProvider>,
  );
  return { onSelect, onOpenMarketplace, ...result };
}

describe("PluginGridButton v3", () => {
  it("renders the trigger button", () => {
    renderGrid([]);
    expect(screen.getByTestId("plugin-grid-button")).toBeInTheDocument();
  });

  it("opens popover on trigger click", () => {
    const plugins = makePlugins(3);
    renderGrid(plugins);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    expect(screen.getByTestId("plugin-grid-popover")).toBeInTheDocument();
  });

  it("renders plugins in a 5-col grid", () => {
    const plugins = makePlugins(5);
    renderGrid(plugins);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const grid = screen.getByTestId("plugin-grid");
    expect(grid).toBeInTheDocument();
    expect(grid.className).toContain("grid-cols-5");
  });

  it("renders plugin cells with labels", () => {
    const plugins = makePlugins(3);
    renderGrid(plugins);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    expect(screen.getByText("Plugin 0")).toBeInTheDocument();
    expect(screen.getByText("Plugin 1")).toBeInTheDocument();
    expect(screen.getByText("Plugin 2")).toBeInTheDocument();
  });

  it("renders '+' add cell", () => {
    const plugins = makePlugins(2);
    renderGrid(plugins);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    expect(screen.getByTestId("plugin-cell-add")).toBeInTheDocument();
    expect(screen.getByText("추가")).toBeInTheDocument();
  });

  it("calls onSelect when a non-installing plugin cell is clicked", () => {
    const plugins = makePlugins(2);
    const onSelect = vi.fn();
    renderGrid(plugins, { onSelect });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    fireEvent.click(screen.getByTestId("plugin-cell-test-0"));
    expect(onSelect).toHaveBeenCalledWith("plugin:test-0:main");
  });

  it("shows install-overlay spinner for installing plugins", () => {
    const plugins = makePlugins(2);
    const installingPluginIds = new Set(["test-1"]);
    renderGrid(plugins, { installingPluginIds });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const installingCell = screen.getByTestId("plugin-cell-test-1");
    expect(installingCell).toHaveAttribute("aria-busy", "true");
    expect(installingCell.className).toContain("cell-installing");
    expect(installingCell.className).toContain("cursor-default");
  });

  it("disables click on installing plugin cells", () => {
    const plugins = makePlugins(2);
    const onSelect = vi.fn();
    const installingPluginIds = new Set(["test-1"]);
    renderGrid(plugins, { onSelect, installingPluginIds });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    fireEvent.click(screen.getByTestId("plugin-cell-test-1"));
    expect(onSelect).not.toHaveBeenCalledWith("plugin:test-1:main");
  });

  it("calls onOpenMarketplace when '+' cell is clicked", () => {
    const plugins = makePlugins(2);
    const onOpenMarketplace = vi.fn();
    renderGrid(plugins, { onOpenMarketplace });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    fireEvent.click(screen.getByTestId("plugin-cell-add"));
    expect(onOpenMarketplace).toHaveBeenCalledOnce();
  });

  it("shows empty state when no plugins and no installing", () => {
    renderGrid([]);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    expect(screen.getByTestId("plugin-grid-empty")).toBeInTheDocument();
    expect(screen.getByText("플러그인이 없습니다")).toBeInTheDocument();
  });

  it("calls onOpenMarketplace from empty state CTA button", () => {
    const onOpenMarketplace = vi.fn();
    renderGrid([], { onOpenMarketplace });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    fireEvent.click(screen.getByText(/마켓플레이스 열기/));
    expect(onOpenMarketplace).toHaveBeenCalledOnce();
  });

  it("does not show empty state when plugins are installing (non-empty set)", () => {
    const installingPluginIds = new Set(["pending-plugin"]);
    renderGrid([], { installingPluginIds });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    expect(screen.queryByTestId("plugin-grid-empty")).not.toBeInTheDocument();
  });

  it("renders scrollable grid for more than 10 plugins", () => {
    const plugins = makePlugins(12);
    renderGrid(plugins);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const grid = screen.getByTestId("plugin-grid");
    expect(grid.className).toContain("max-h-[220px]");
    expect(grid.className).toContain("overflow-y-auto");
  });
});
