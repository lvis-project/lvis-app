import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ChatGroupFrame, buildChatGroupActions, useChatGroups } from "../ChatGroupFrame.js";

const t = ((key: string) => key) as never;

describe("ChatGroupFrame", () => {
  afterEach(cleanup);

  it("names the conversation on the leading edge of its own header", () => {
    render(
      <TooltipProvider><ChatGroupFrame title="전체 동기화로 상태 파악" actions={[]} sidebarOpen={false} onToggleSidebar={vi.fn()}>
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    expect(screen.getByTestId("chat-group-header").textContent).toContain("전체 동기화로 상태 파악");
  });

  it("expresses focus on the frame, not on the content", () => {
    const view = render(
      <TooltipProvider><ChatGroupFrame title="a" actions={[]} sidebarOpen={false} onToggleSidebar={vi.fn()}>
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    expect(
      view.container.querySelector('[data-testid="chat-group"]')?.getAttribute("data-focused"),
    ).toBeNull();
    view.rerender(
      <TooltipProvider><ChatGroupFrame title="a" focused actions={[]} sidebarOpen={false} onToggleSidebar={vi.fn()}>
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    expect(
      view.container.querySelector('[data-testid="chat-group"]')?.getAttribute("data-focused"),
    ).toBe("true");
  });

  it("carries the conversation's own actions in its header", () => {
    const onTogglePin = vi.fn();
    const onImport = vi.fn();
    render(
      <TooltipProvider><ChatGroupFrame
        title="a"
        actions={buildChatGroupActions({
          t,
          pinned: false,
          onTogglePin,
          onExport: vi.fn(),
          onImport,
        })}
        sidebarOpen={false}
        onToggleSidebar={vi.fn()}
      >
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId("chat-group-action-conversation.pin"));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("chat-group-action-conversation.import"));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("names the pin action by what the click will do, so a pinned row offers unpin", () => {
    render(
      <TooltipProvider><ChatGroupFrame
        title="a"
        actions={buildChatGroupActions({
          t,
          pinned: true,
          onTogglePin: vi.fn(),
          onExport: vi.fn(),
          onImport: vi.fn(),
        })}
        sidebarOpen={false}
        onToggleSidebar={vi.fn()}
      >
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    const unpin = screen.getByTestId("chat-group-action-conversation.unpin");
    expect(unpin.getAttribute("aria-label")).toBe("mainToolbar.sessionUnstar");
    expect(unpin.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("chat-group-action-conversation.pin")).toBeNull();
  });

  it("owns its own sidebar — the toggle opens the list inside this frame", () => {
    const onToggleSidebar = vi.fn();
    render(
      <TooltipProvider><ChatGroupFrame
        title="a"
        actions={[]}
        sidebarOpen
        onToggleSidebar={onToggleSidebar}
        sidebar={<div data-testid="group-list">list</div>}
      >
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    const toggle = screen.getByTestId("chat-group-sidebar-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("chat-group-sidebar").contains(screen.getByTestId("group-list"))).toBe(true);
    fireEvent.click(toggle);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("offers no close on the last group and no split once the sources are used", () => {
    render(
      <TooltipProvider><ChatGroupFrame title="a" actions={[]} sidebarOpen={false} onToggleSidebar={vi.fn()}>
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    // Both controls are absent rather than disabled: a control that can never
    // do anything in this state is not a control the user should have to read.
    expect(screen.queryByTestId("chat-group-close")).toBeNull();
    expect(screen.queryByTestId("chat-group-split")).toBeNull();
  });
});

describe("useChatGroups", () => {
  afterEach(cleanup);

  it("starts with one group and splits to the second conversation source", () => {
    const { result } = renderHook(() => useChatGroups());
    expect(result.current.groups.map((group) => group.source)).toEqual(["main"]);
    expect(result.current.canSplit).toBe(true);
    act(() => result.current.split());
    expect(result.current.groups.map((group) => group.source)).toEqual(["main", "side"]);
  });

  it("stops splitting at the number of loops that exist, rather than opening a dead tile", () => {
    const { result } = renderHook(() => useChatGroups());
    act(() => result.current.split());
    expect(result.current.canSplit).toBe(false);
    act(() => result.current.split());
    expect(result.current.groups).toHaveLength(2);
  });

  it("moves focus to the new group and back when it closes", () => {
    const { result } = renderHook(() => useChatGroups());
    act(() => result.current.split());
    expect(result.current.focusedId).toBe("side");
    act(() => result.current.close("side"));
    expect(result.current.focusedId).toBe("main");
  });

  it("keeps the last group — closing it would leave nothing to reopen from", () => {
    const { result } = renderHook(() => useChatGroups());
    act(() => result.current.close("main"));
    expect(result.current.groups).toHaveLength(1);
  });

  it("tracks each group's sidebar separately", () => {
    const { result } = renderHook(() => useChatGroups());
    act(() => result.current.split());
    act(() => result.current.toggleSidebar("side"));
    expect(result.current.groups.find((g) => g.id === "main")?.sidebarOpen).toBe(false);
    expect(result.current.groups.find((g) => g.id === "side")?.sidebarOpen).toBe(true);
  });
});
