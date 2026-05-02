import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { PluginGridButton, type PluginEntry } from "../components/PluginGridButton.js";
import type { InstallPhase } from "../hooks/use-plugin-marketplace.js";

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
    installingPlugins?: Map<string, InstallPhase>;
    onSelect?: (k: string) => void;
    onOpenMarketplace?: () => void;
    marketplaceUrlReady?: boolean;
  } = {},
) {
  const onSelect = opts.onSelect ?? vi.fn();
  const onOpenMarketplace = opts.onOpenMarketplace ?? vi.fn();
  // Default to ready so marketplace-interaction tests work without extra boilerplate.
  const marketplaceUrlReady = opts.marketplaceUrlReady ?? true;
  const result = render(
    <TooltipProvider>
      <PluginGridButton
        plugins={plugins}
        installingPlugins={opts.installingPlugins}
        onSelect={onSelect}
        onOpenMarketplace={onOpenMarketplace}
        marketplaceUrlReady={marketplaceUrlReady}
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

  it("renders plugins in a fluid auto-fill grid", () => {
    const plugins = makePlugins(5);
    renderGrid(plugins);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const grid = screen.getByTestId("plugin-grid");
    expect(grid).toBeInTheDocument();
    // Column count is fluid (`repeat(auto-fill, minmax(80px, 1fr))`) so it
    // tracks the chat panel width — no hard-coded grid-cols-N.
    expect(grid.className).toMatch(/grid-cols-\[repeat\(auto-fill/);
  });

  it("renders plugin cells with labels", () => {
    const plugins = makePlugins(3);
    renderGrid(plugins);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    expect(screen.getByText("Plugin 0")).toBeInTheDocument();
    expect(screen.getByText("Plugin 1")).toBeInTheDocument();
    expect(screen.getByText("Plugin 2")).toBeInTheDocument();
  });

  it("renders marketplace cell at the end of a non-empty grid", () => {
    const plugins = makePlugins(2);
    renderGrid(plugins);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    expect(screen.getByTestId("plugin-cell-add")).toBeInTheDocument();
    expect(screen.getByText("마켓")).toBeInTheDocument();
  });

  it("calls onSelect when a non-installing plugin cell is clicked", () => {
    const plugins = makePlugins(2);
    const onSelect = vi.fn();
    renderGrid(plugins, { onSelect });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    fireEvent.click(screen.getByTestId("plugin-cell-test-0"));
    expect(onSelect).toHaveBeenCalledWith("plugin:test-0:main");
  });

  it("shows install-overlay spinner + phase label for installing registered plugins", () => {
    const plugins = makePlugins(2);
    const installingPlugins = new Map<string, InstallPhase>([["test-1", "restarting"]]);
    renderGrid(plugins, { installingPlugins });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const installingCell = screen.getByTestId("plugin-cell-test-1");
    expect(installingCell).toHaveAttribute("aria-busy", "true");
    expect(installingCell.className).toContain("cell-installing");
    expect(installingCell.className).toContain("cursor-default");
    // Phase label sits inside the spinner ring.
    expect(screen.getByTestId("plugin-cell-test-1-phase").textContent).toBe("재시작");
  });

  it("disables click on installing plugin cells", () => {
    const plugins = makePlugins(2);
    const onSelect = vi.fn();
    const installingPlugins = new Map<string, InstallPhase>([["test-1", "restarting"]]);
    renderGrid(plugins, { onSelect, installingPlugins });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    fireEvent.click(screen.getByTestId("plugin-cell-test-1"));
    expect(onSelect).not.toHaveBeenCalledWith("plugin:test-1:main");
  });

  it("renders a placeholder cell + phase label for in-flight slugs not yet registered", () => {
    const plugins = makePlugins(2);
    const installingPlugins = new Map<string, InstallPhase>([
      ["calendar", "downloading"],
      ["search", "installing"],
    ]);
    renderGrid(plugins, { installingPlugins });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));

    const calendarCell = screen.getByTestId("plugin-cell-installing-calendar");
    expect(calendarCell).toBeInTheDocument();
    expect(calendarCell).toHaveAttribute("aria-busy", "true");
    expect(calendarCell.className).toContain("cell-installing");
    expect(screen.getByTestId("plugin-cell-installing-calendar-phase").textContent).toBe("다운로드");
    expect(calendarCell.textContent).toContain("calendar");

    const searchCell = screen.getByTestId("plugin-cell-installing-search");
    expect(searchCell).toBeInTheDocument();
    expect(screen.getByTestId("plugin-cell-installing-search-phase").textContent).toBe("설치");
  });

  it("does NOT render a placeholder cell when the slug is already a registered plugin", () => {
    const plugins = makePlugins(2);
    const installingPlugins = new Map<string, InstallPhase>([["test-0", "restarting"]]);
    renderGrid(plugins, { installingPlugins });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    // Registered cell exists; no duplicate placeholder cell.
    expect(screen.getByTestId("plugin-cell-test-0")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-cell-installing-test-0")).not.toBeInTheDocument();
  });

  it("calls onOpenMarketplace when the marketplace cell is clicked", () => {
    const plugins = makePlugins(2);
    const onOpenMarketplace = vi.fn();
    renderGrid(plugins, { onOpenMarketplace });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    fireEvent.click(screen.getByTestId("plugin-cell-add"));
    expect(onOpenMarketplace).toHaveBeenCalledOnce();
  });

  it("shows empty state without a marketplace grid cell when no plugins and no installing", () => {
    renderGrid([]);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    expect(screen.getByTestId("plugin-grid-empty")).toBeInTheDocument();
    expect(screen.getByText("플러그인이 없습니다")).toBeInTheDocument();
    // Scenario 3: marketplace CTA in the empty body, no separate grid "+" cell.
    expect(screen.queryByTestId("plugin-cell-add")).not.toBeInTheDocument();
  });

  it("calls onOpenMarketplace from empty state CTA button", () => {
    const onOpenMarketplace = vi.fn();
    renderGrid([], { onOpenMarketplace });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    fireEvent.click(screen.getByText(/마켓플레이스 열기/));
    expect(onOpenMarketplace).toHaveBeenCalledOnce();
  });

  it("does not show empty state when plugins are installing (non-empty map)", () => {
    const installingPlugins = new Map<string, InstallPhase>([["pending-plugin", "downloading"]]);
    renderGrid([], { installingPlugins });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    expect(screen.queryByTestId("plugin-grid-empty")).not.toBeInTheDocument();
    // Placeholder cell + spinner + phase label visible inside the popover.
    expect(screen.getByTestId("plugin-cell-installing-pending-plugin")).toBeInTheDocument();
    expect(screen.getByTestId("plugin-cell-installing-pending-plugin-phase").textContent).toBe("다운로드");
  });

  it("renders scrollable grid for more than 10 plugins", () => {
    const plugins = makePlugins(12);
    renderGrid(plugins);
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const grid = screen.getByTestId("plugin-grid");
    expect(grid.className).toContain("max-h-[220px]");
    expect(grid.className).toContain("overflow-y-auto");
  });

  it("disables marketplace cell and shows loading label when marketplaceUrlReady is false", () => {
    const plugins = makePlugins(2);
    const onOpenMarketplace = vi.fn();
    renderGrid(plugins, { onOpenMarketplace, marketplaceUrlReady: false });
    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const addCell = screen.getByTestId("plugin-cell-add");
    expect(addCell).toBeDisabled();
    expect(addCell.className).toContain("cursor-default");
    expect(screen.getByText("로딩 중")).toBeInTheDocument();
    fireEvent.click(addCell);
    expect(onOpenMarketplace).not.toHaveBeenCalled();
  });
});
