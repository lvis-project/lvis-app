// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolActivityBody, ToolActivityWorkspace } from "../ToolActivity.js";
import { emptyToolActivity, renderWithTooltipProvider as renderPanel } from "../../../../../test/renderer/helpers.js";

describe("ToolActivityBody item routing", () => {
  it("single-click routes ephemeral, double-click routes pinned (VS Code preview-tab model)", () => {
    const onOpenItem = vi.fn();
    const onOpenItemPinned = vi.fn();
    const activity = emptyToolActivity();
    activity.readFileCount = 1;
    activity.readFiles = [
      { id: "read-1", label: "report.md", detail: "C:/ws/report.md", target: "C:\\ws\\report.md", status: "done" },
    ];

    renderPanel(
      <ToolActivityBody activity={activity} onOpenItem={onOpenItem} onOpenItemPinned={onOpenItemPinned} />,
    );

    const row = screen.getByTestId("tool-activity-item-read-1");

    fireEvent.click(row);
    expect(onOpenItem).toHaveBeenCalledWith("C:\\ws\\report.md", false);
    expect(onOpenItemPinned).not.toHaveBeenCalled();

    fireEvent.doubleClick(row);
    expect(onOpenItemPinned).toHaveBeenCalledWith("C:\\ws\\report.md", false);
  });

  it("double-click on a web row routes pinned with web=true", () => {
    const onOpenItem = vi.fn();
    const onOpenItemPinned = vi.fn();
    const activity = emptyToolActivity();
    activity.fetchedPageCount = 1;
    activity.fetchedPages = [
      { id: "page-1", label: "example.com", target: "https://example.com/docs", status: "done" },
    ];

    renderPanel(
      <ToolActivityBody activity={activity} onOpenItem={onOpenItem} onOpenItemPinned={onOpenItemPinned} />,
    );

    fireEvent.doubleClick(screen.getByTestId("tool-activity-item-page-1"));
    expect(onOpenItemPinned).toHaveBeenCalledWith("https://example.com/docs", true);
  });

  it("keeps the newest five per list, labels each changed file with its change, and offers the full activity tab", () => {
    const onOpenActivityTab = vi.fn();
    const activity = emptyToolActivity();
    activity.readFileCount = 6;
    activity.readFiles = Array.from({ length: 6 }, (_, index) => ({
      id: `read-${index}`,
      label: `latest-read-${index}`,
      target: `C:\\tmp\\latest-read-${index}.md`,
    }));
    activity.changedFileCount = 2;
    activity.changedFiles = [
      { id: "change-1", label: "C:\\tmp\\gone.md", target: "C:\\tmp\\gone.md", operation: "delete" },
      { id: "change-2", label: "C:\\tmp\\new.md", target: "C:\\tmp\\new.md", operation: "create" },
    ];

    renderPanel(<ToolActivityBody activity={activity} onOpenItem={vi.fn()} onOpenActivityTab={onOpenActivityTab} />);

    expect(document.body.textContent).toContain("latest-read-4");
    expect(document.body.textContent).not.toContain("latest-read-5");
    expect(screen.getAllByTestId("tool-activity-operation").map((badge) => badge.textContent)).toEqual(["삭제", "생성"]);
    fireEvent.click(screen.getByTestId("tool-activity-open-tab"));
    expect(onOpenActivityTab).toHaveBeenCalledTimes(1);
  });
});

describe("ToolActivityWorkspace", () => {
  it("lists every tool call with its source, clock when live, and duration when finished", () => {
    const activity = emptyToolActivity();
    activity.toolCallCount = 7;
    activity.toolCalls = Array.from({ length: 7 }, (_, index) => ({
      id: `call:${index}`,
      name: `tool_${index}`,
      status: "done" as const,
      source: index === 0 ? "mcp" : "builtin",
      ...(index === 0 ? { mcpServerId: "srv", durationMs: 250 } : {}),
      ...(index === 1 ? { startedAt: Date.UTC(2026, 0, 1, 12, 0, 0), argument: "https://example.com/a" } : {}),
    }));

    renderPanel(<ToolActivityWorkspace activity={activity} />);

    const rows = screen.getAllByTestId("chat-side-panel-activity-tool-row");
    // No five-row cap here — this tab is the full list.
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveTextContent("mcp:srv");
    expect(rows[0]).toHaveTextContent("0.3s");
    expect(rows[1]).toHaveTextContent("https://example.com/a");
    expect(rows[1]).toHaveTextContent(new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    expect(screen.getByTestId("chat-side-panel-activity-plugins")).toHaveTextContent("아직 호출한 플러그인이 없습니다.");
  });
});
