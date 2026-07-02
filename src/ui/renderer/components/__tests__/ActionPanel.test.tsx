// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ActionPanel, type ActionPanelActivityState } from "../ActionPanel.js";

function emptyActivity(): ActionPanelActivityState {
  return {
    readFileCount: 0,
    writtenFileCount: 0,
    mcpCallCount: 0,
    pluginCallCount: 0,
    toolCallCount: 0,
    fetchedPageCount: 0,
    readFiles: [],
    writtenFiles: [],
    pluginCalls: [],
    mcpCalls: [],
    fetchedPages: [],
  };
}

function renderPanel(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("ActionPanel item routing", () => {
  it("single-click routes ephemeral, double-click routes pinned (VS Code preview-tab model)", () => {
    const onOpenItem = vi.fn();
    const onOpenItemPinned = vi.fn();
    const activity = emptyActivity();
    activity.readFileCount = 1;
    activity.readFiles = [
      { id: "read-1", label: "report.md", detail: "C:/ws/report.md", target: "C:\\ws\\report.md", status: "done" },
    ];

    renderPanel(
      <ActionPanel
        open
        onOpenChange={vi.fn()}
        activity={activity}
        onOpenItem={onOpenItem}
        onOpenItemPinned={onOpenItemPinned}
      />,
    );

    const row = screen.getByTestId("action-panel-activity-read-1");

    fireEvent.click(row);
    expect(onOpenItem).toHaveBeenCalledWith("C:\\ws\\report.md", false);
    expect(onOpenItemPinned).not.toHaveBeenCalled();

    fireEvent.doubleClick(row);
    expect(onOpenItemPinned).toHaveBeenCalledWith("C:\\ws\\report.md", false);
  });

  it("double-click on a web row routes pinned with web=true", () => {
    const onOpenItem = vi.fn();
    const onOpenItemPinned = vi.fn();
    const activity = emptyActivity();
    activity.fetchedPageCount = 1;
    activity.fetchedPages = [
      { id: "page-1", label: "example.com", target: "https://example.com/docs", status: "done" },
    ];

    renderPanel(
      <ActionPanel
        open
        onOpenChange={vi.fn()}
        activity={activity}
        onOpenItem={onOpenItem}
        onOpenItemPinned={onOpenItemPinned}
      />,
    );

    fireEvent.doubleClick(screen.getByTestId("action-panel-activity-page-1"));
    expect(onOpenItemPinned).toHaveBeenCalledWith("https://example.com/docs", true);
  });
});
