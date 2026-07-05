// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { Sidebar } from "../Sidebar.js";

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props: Parameters<typeof Sidebar>[0] = {
    activeView: "home",
    onSelect: vi.fn(),
    pluginViews: [],
    failedPluginCards: [],
    hasApiKey: true,
    onOpenSettings: vi.fn(),
    onNewChat: vi.fn(),
    streaming: false,
    onOpenMarketplace: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    onOpenUnifiedSearch: vi.fn(),
    isCurrentSessionStarred: false,
    onToggleCurrentSessionStar: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  };
  render(
    <TooltipProvider>
      <Sidebar {...props} />
    </TooltipProvider>,
  );
  return props;
}

describe("Sidebar plugin Doctor affordance", () => {
  it("shows failed plugins and routes them to the Doctor navigation key", () => {
    const onSelect = vi.fn();
    renderSidebar({
      onSelect,
      failedPluginCards: [{
        id: "agent-hub",
        name: "Agent Hub",
        description: "Agent orchestration",
        publisher: "Test fixture",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "failed",
      }],
    });

    const row = screen.getByTestId("sidebar-plugin-doctor-agent-hub");
    expect(row.textContent).toContain("Agent Hub");
    expect(row.textContent).toContain("Doctor");

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("plugin-doctor:agent-hub");
  });
});
