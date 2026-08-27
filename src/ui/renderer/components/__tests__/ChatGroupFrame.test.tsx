import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ChatGroupFrame, buildChatGroupActions, chatGroupApi, useChatGroups } from "../ChatGroupFrame.js";
import type { LvisApi } from "../../types.js";

const t = ((key: string) => key) as never;

function frame(props: Partial<React.ComponentProps<typeof ChatGroupFrame>> = {}) {
  return (
    <TooltipProvider>
      <ChatGroupFrame
        title="a"
        actions={[]}
        panelOpen={false}
        onTogglePanel={vi.fn()}
        {...props}
      >
        <div>body</div>
      </ChatGroupFrame>
    </TooltipProvider>
  );
}

describe("ChatGroupFrame", () => {
  afterEach(cleanup);

  it("names the conversation on the leading edge of its own header", () => {
    render(frame({ title: "전체 동기화로 상태 파악" }));
    expect(screen.getByTestId("chat-group-header").textContent).toContain("전체 동기화로 상태 파악");
  });

  it("expresses focus on the frame, not on the content", () => {
    const view = render(frame());
    expect(
      view.container.querySelector('[data-testid="chat-group"]')?.getAttribute("data-focused"),
    ).toBeNull();
    view.rerender(frame({ focused: true }));
    expect(
      view.container.querySelector('[data-testid="chat-group"]')?.getAttribute("data-focused"),
    ).toBe("true");
  });

  it("carries the conversation's own actions in its header", () => {
    const onTogglePin = vi.fn();
    const onImport = vi.fn();
    render(frame({
      actions: buildChatGroupActions({
        t,
        pinned: false,
        onTogglePin,
        onExport: vi.fn(),
        onImport,
      }),
    }));
    fireEvent.click(screen.getByTestId("chat-group-action-conversation.pin"));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("chat-group-action-conversation.import"));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("names the pin action by what the click will do, so a pinned row offers unpin", () => {
    render(frame({
      actions: buildChatGroupActions({
        t,
        pinned: true,
        onTogglePin: vi.fn(),
        onExport: vi.fn(),
        onImport: vi.fn(),
      }),
    }));
    const unpin = screen.getByTestId("chat-group-action-conversation.unpin");
    expect(unpin.getAttribute("aria-label")).toBe("mainToolbar.sessionUnstar");
    expect(unpin.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("chat-group-action-conversation.pin")).toBeNull();
  });

  it("owns the work-panel toggle — the panel belongs to this conversation", () => {
    const onTogglePanel = vi.fn();
    render(frame({ panelOpen: true, onTogglePanel }));
    const toggle = screen.getByTestId("chat-group-panel-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(onTogglePanel).toHaveBeenCalledTimes(1);
  });

  it("does not render a conversation list of its own — that is the window's sidebar", () => {
    render(frame());
    expect(screen.queryByTestId("chat-group-sidebar")).toBeNull();
    expect(screen.queryByTestId("chat-group-sidebar-toggle")).toBeNull();
  });

  it("publishes a header slot ahead of the fixed actions, for contributed controls", () => {
    render(frame({
      actions: buildChatGroupActions({
        t,
        pinned: false,
        onTogglePin: vi.fn(),
        onExport: vi.fn(),
        onImport: vi.fn(),
      }),
    }));
    const slot = screen.getByTestId("chat-group-header-slot");
    const pin = screen.getByTestId("chat-group-action-conversation.pin");
    // Contributed first, pin second: the fixed set keeps its order whatever the
    // transcript decides to contribute.
    expect(slot.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers no close on the last group", () => {
    render(frame());
    // Absent rather than disabled: a control that can never do anything in this
    // state is not a control the user should have to read.
    expect(screen.queryByTestId("chat-group-close")).toBeNull();
  });
});

describe("useChatGroups", () => {
  afterEach(cleanup);

  it("starts with the one group whose conversation loop actually exists", () => {
    const { result } = renderHook(() => useChatGroups());
    expect(result.current.groups.map((group) => group.id)).toEqual(["main"]);
    expect(result.current.focusedId).toBe("main");
  });

  it("tracks the work panel per group rather than per window", () => {
    const { result } = renderHook(() => useChatGroups());
    expect(result.current.groups[0]!.panelOpen).toBe(false);
    act(() => result.current.setPanelOpen("main", true));
    expect(result.current.groups[0]!.panelOpen).toBe(true);
    act(() => result.current.setPanelOpen("main", false));
    expect(result.current.groups[0]!.panelOpen).toBe(false);
  });
});

describe("chatGroupApi", () => {
  it("layers the group binding over the rest of the api", () => {
    // chatGroup() rebinds the chat channels only. A tile also calls
    // getSettings, which lives on another preload surface — returning the bare
    // binding hands the tile an api that is missing most of itself.
    const getSettings = vi.fn();
    const boundSend = vi.fn();
    const chatGroup = vi.fn(() => ({ send: boundSend }) as unknown as LvisApi);
    const api = { chatGroup, getSettings, send: vi.fn() } as unknown as LvisApi;

    const tile = chatGroupApi(api, "group-2") as unknown as Record<string, unknown>;

    expect(chatGroup).toHaveBeenCalledWith("group-2");
    expect(tile.send).toBe(boundSend);
    expect(tile.getSettings).toBe(getSettings);
  });

  it("hands the same view back for the same group so memos below it hold", () => {
    const chatGroup = vi.fn(() => ({}) as unknown as LvisApi);
    const api = { chatGroup } as unknown as LvisApi;

    expect(chatGroupApi(api, "group-2")).toBe(chatGroupApi(api, "group-2"));
    expect(chatGroup).toHaveBeenCalledTimes(1);
  });

  it("leaves the primary group on the top-level surface, which already binds it", () => {
    const chatGroup = vi.fn();
    const api = { chatGroup } as unknown as LvisApi;

    expect(chatGroupApi(api, "main")).toBe(api);
    expect(chatGroup).not.toHaveBeenCalled();
  });

  it("refuses a non-primary group on a surface that cannot bind one", () => {
    // Returning the unbound surface would put this tile's turns in the primary
    // conversation — a wrong answer is worse than a rejected one.
    const api = {} as unknown as LvisApi;

    expect(chatGroupApi(api, "main")).toBe(api);
    expect(() => chatGroupApi(api, "group-2")).toThrow(/chat-group-unavailable/);
  });
});

describe("useChatGroups ceilings", () => {
  it("collapses to the focused tile in chat mode and offers no split there", () => {
    const { result } = renderHook(() => useChatGroups("chat"));

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.canSplit).toBe(false);
  });

  it("never closes the primary group", () => {
    const { result } = renderHook(() => useChatGroups("work"));

    act(() => result.current.close("main"));
    expect(result.current.groups.map((group) => group.id)).toEqual(["main"]);
  });
});
