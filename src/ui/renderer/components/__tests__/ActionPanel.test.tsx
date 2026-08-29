// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionPanel } from "../ActionPanel.js";
import { emptyActionPanelActivity, renderWithTooltipProvider as renderPanel } from "../../../../../test/renderer/helpers.js";

describe("ActionPanel item routing", () => {
  it("single-click routes ephemeral, double-click routes pinned (VS Code preview-tab model)", () => {
    const onOpenItem = vi.fn();
    const onOpenItemPinned = vi.fn();
    const activity = emptyActionPanelActivity();
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
    const activity = emptyActionPanelActivity();
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
