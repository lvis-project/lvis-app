import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ChatGroupFrame, ChatGroupGutter, buildChatGroupActions, chatGroupApi, useChatGroups } from "../ChatGroupFrame.js";
import { layoutBoxes, layoutGutters, leaf, resizeGutter, splitLeaf, type ChatGroupGutter as ChatGroupGutterShape } from "../chat-group-tree.js";
import { CHAT_SESSION_DRAG_TYPE } from "../chat-group-drop.js";
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

  it("offers show-alone only when told there is something to hide, and names the way back", () => {
    const onToggleMaximize = vi.fn();
    const view = render(frame());
    expect(screen.queryByTestId("chat-group-maximize")).toBeNull();
    view.rerender(frame({ onToggleMaximize }));
    const control = screen.getByTestId("chat-group-maximize");
    expect(control.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(control);
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
    view.rerender(frame({ onToggleMaximize, maximized: true }));
    expect(screen.getByTestId("chat-group-maximize").getAttribute("aria-pressed")).toBe("true");
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

describe("useChatGroups placement", () => {
  it("starts as a single tile filling the area", () => {
    const { result } = renderHook(() => useChatGroups("work"));

    expect(result.current.groups.map((g) => g.id)).toEqual(["main"]);
    expect(result.current.groups[0]!.box).toMatchObject({
      left: 0, top: 0, width: 100, height: 100,
    });
  });

  it("splits the dropped-on tile and focuses what was added", () => {
    const { result } = renderHook(() => useChatGroups("work"));

    let added: string | null = null;
    act(() => { added = result.current.dropOnEdge("main", "right"); });

    expect(added).toBe("group-2");
    expect(result.current.focusedId).toBe("group-2");
    expect(result.current.groups.map((g) => g.id)).toEqual(["main", "group-2"]);
    expect(result.current.groups[1]!.box).toMatchObject({ left: 50, width: 50, height: 100 });
  });

  it("refuses a drop past the ceiling instead of silently ignoring it", () => {
    // The caller shows no edge affordance when this returns null, so the limit
    // is visible in the gesture rather than as a rejection after the fact.
    const { result } = renderHook(() => useChatGroups("work"));

    act(() => { result.current.dropOnEdge("main", "right"); });
    act(() => { result.current.dropOnEdge("group-2", "bottom"); });
    act(() => { result.current.dropOnEdge("group-3", "bottom"); });

    let overflow: string | null = "not-run";
    act(() => { overflow = result.current.dropOnEdge("group-4", "right"); });

    expect(result.current.groups).toHaveLength(4);
    expect(overflow).toBeNull();
  });

  it("never reuses a closed tile's id", () => {
    // Main-process loops are keyed by this id: reusing one would hand a new
    // tile the previous tile's live history.
    const { result } = renderHook(() => useChatGroups("work"));

    act(() => { result.current.dropOnEdge("main", "right"); });
    act(() => { result.current.close("group-2"); });
    let reborn: string | null = null;
    act(() => { reborn = result.current.dropOnEdge("main", "right"); });

    expect(reborn).toBe("group-3");
  });

  it("gives a closed tile's space back and keeps focus on a tile that exists", () => {
    const { result } = renderHook(() => useChatGroups("work"));

    act(() => { result.current.dropOnEdge("main", "right"); });
    act(() => { result.current.close("group-2"); });

    expect(result.current.groups.map((g) => g.id)).toEqual(["main"]);
    expect(result.current.groups[0]!.box).toMatchObject({ width: 100, height: 100 });
    expect(result.current.focusedId).toBe("main");
  });
});

describe("useChatGroups ceilings", () => {
  it("collapses to the focused tile in chat mode and offers no split there", () => {
    const { result } = renderHook(() => useChatGroups("chat"));

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.canSplit).toBe(false);
  });

  it("never closes the last group, but once split the primary closes like any other", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    expect(result.current.closable).toBe(false);
    act(() => result.current.close("main"));
    expect(result.current.groups.map((group) => group.id)).toEqual(["main"]);

    act(() => result.current.dropOnEdge("main", "right"));
    expect(result.current.closable).toBe(true);
    act(() => result.current.close("main"));
    expect(result.current.groups.map((group) => group.id)).toEqual(["group-2"]);
    expect(result.current.focusedId).toBe("group-2");
    expect(result.current.closable).toBe(false);
  });

  it("offers neither close nor show-alone in chat mode, which already shows one tile and hides the rest", () => {
    const { result, rerender } = renderHook(({ mode }: { mode: "chat" | "work" }) => useChatGroups(mode), {
      initialProps: { mode: "work" as "chat" | "work" },
    });
    act(() => result.current.dropOnEdge("main", "right"));
    expect(result.current.closable).toBe(true);
    rerender({ mode: "chat" });
    expect(result.current.groups).toHaveLength(1);
    expect(result.current.closable).toBe(false);
    expect(result.current.canMaximize).toBe(false);
  });

  it("shows one tile alone on maximize and gives the others back on restore, closing nothing", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    expect(result.current.canMaximize).toBe(false);
    act(() => result.current.dropOnEdge("main", "right"));
    expect(result.current.canMaximize).toBe(true);

    act(() => result.current.toggleMaximize("group-2"));
    expect(result.current.maximizedId).toBe("group-2");
    expect(result.current.groups.map((group) => group.id)).toEqual(["group-2"]);
    expect(result.current.gutters).toEqual([]);
    // Still two tiles: the view changed, not the workspace.
    expect(result.current.closable).toBe(true);

    act(() => result.current.toggleMaximize("group-2"));
    expect(result.current.maximizedId).toBeNull();
    expect(result.current.groups.map((group) => group.id)).toEqual(["main", "group-2"]);
  });

  it("drops a maximize when its tile closes or another tile is added", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.dropOnEdge("main", "right"));
    act(() => result.current.toggleMaximize("group-2"));
    act(() => result.current.close("group-2"));
    expect(result.current.maximizedId).toBeNull();
    expect(result.current.groups.map((group) => group.id)).toEqual(["main"]);

    act(() => result.current.dropOnEdge("main", "right"));
    act(() => result.current.toggleMaximize("main"));
    act(() => result.current.dropOnEdge("main", "bottom"));
    expect(result.current.maximizedId).toBeNull();
    expect(result.current.groups).toHaveLength(3);
  });
});

describe("ChatGroupFrame drop gesture", () => {
  afterEach(cleanup);

  const TILE = { left: 0, top: 0, width: 800, height: 600 };

  function tileWithRect(props: Partial<React.ComponentProps<typeof ChatGroupFrame>>) {
    const view = render(frame(props));
    const tile = view.container.querySelector('[data-testid="chat-group"]')!;
    // jsdom lays nothing out, so the tile has to be told how big it is — the
    // whole gesture is read off that rectangle.
    tile.getBoundingClientRect = () => ({
      ...TILE,
      right: TILE.width,
      bottom: TILE.height,
      x: TILE.left,
      y: TILE.top,
      toJSON: () => ({}),
    }) as DOMRect;
    return tile;
  }

  const carriedSession = {
    types: [CHAT_SESSION_DRAG_TYPE],
    getData: () => "session-7",
    dropEffect: "none",
  };

  /**
   * jsdom's drag events drop the pointer coordinates on the floor, and the
   * whole gesture is those coordinates — so they are set on the event itself.
   */
  function drag(
    kind: "dragOver" | "drop",
    tile: Element,
    dataTransfer: unknown,
    point: { x: number; y: number },
  ) {
    const event = createEvent[kind](tile, { dataTransfer });
    Object.defineProperty(event, "clientX", { value: point.x });
    Object.defineProperty(event, "clientY", { value: point.y });
    fireEvent(tile, event);
  }

  it("reports the edge a conversation landed on", () => {
    const onSessionDrop = vi.fn();
    const tile = tileWithRect({ onSessionDrop, canSplit: true });

    // Each side, and the middle. A tile with no size answers "right" to
    // every point (the far edge is nearest to everything), so only the other
    // answers prove the rectangle was actually read.
    drag("drop", tile, carriedSession, { x: 5, y: 300 });
    drag("drop", tile, carriedSession, { x: 400, y: 5 });
    drag("drop", tile, carriedSession, { x: 400, y: 595 });
    drag("drop", tile, carriedSession, { x: 400, y: 300 });
    drag("drop", tile, carriedSession, { x: 795, y: 300 });

    expect(onSessionDrop.mock.calls.map((call) => call[1])).toEqual(["left", "top", "bottom", "center", "right"]);
  });

  it("collapses every edge to the centre once no tile fits, so the ceiling is felt before the drop", () => {
    const onSessionDrop = vi.fn();
    const tile = tileWithRect({ onSessionDrop, canSplit: false });

    drag("dragOver", tile, carriedSession, { x: 795, y: 300 });
    expect(tile.getAttribute("data-drop-target")).toBe("center");

    drag("drop", tile, carriedSession, { x: 795, y: 300 });
    expect(onSessionDrop).toHaveBeenCalledWith("session-7", "center");
  });

  it("ignores a drag that is not carrying a conversation", () => {
    const onSessionDrop = vi.fn();
    const tile = tileWithRect({ onSessionDrop, canSplit: true });

    const file = { types: ["Files"], getData: () => "", dropEffect: "none" };
    drag("dragOver", tile, file, { x: 795, y: 300 });
    expect(tile.getAttribute("data-drop-target")).toBeNull();

    drag("drop", tile, file, { x: 795, y: 300 });
    expect(onSessionDrop).not.toHaveBeenCalled();
  });
});

describe("ChatGroupGutter", () => {
  afterEach(cleanup);

  /** A canvas holding two tiles side by side, split down the middle. */
  function canvasWithTwoTiles(width = 1000) {
    const canvas = document.createElement("div");
    Object.defineProperty(canvas, "clientWidth", { value: width });
    Object.defineProperty(canvas, "clientHeight", { value: 700 });
    for (const id of ["main", "group-2"]) {
      const cell = document.createElement("div");
      cell.setAttribute("data-testid", `chat-group-cell:${id}`);
      canvas.appendChild(cell);
    }
    document.body.appendChild(canvas);
    return canvas;
  }

  function renderGutter(canvas: HTMLElement, onResize = vi.fn()) {
    const tree = splitLeaf(leaf("main"), "main", "right", "group-2");
    const [gutter] = layoutGutters(tree);
    const previewResize = (g: ChatGroupGutterShape, share: number) => {
      const next = resizeGutter(tree, g, share);
      return { boxes: layoutBoxes(next), gutters: layoutGutters(next) };
    };
    const view = render(
      <TooltipProvider>
        <ChatGroupGutter
          gutter={gutter!}
          canvasRef={{ current: canvas }}
          previewResize={previewResize}
          onResize={onResize}
        />
      </TooltipProvider>,
      // A root of its own: createRoot empties its container, and the cells
      // have to survive as the gutter's siblings for the paint to find them.
      { container: canvas.appendChild(document.createElement("div")) },
    );
    return { view, gutter: gutter!, onResize };
  }

  it("stands on the boundary as the same separator the side panel resizes with", () => {
    const canvas = canvasWithTwoTiles();
    const { gutter } = renderGutter(canvas);
    const bar = screen.getByTestId(`chat-group-gutter-bar:${gutter.key}`);
    expect(bar.getAttribute("role")).toBe("separator");
    // A width-resizing bar stands vertical; its value is the leading tile's px.
    expect(bar.getAttribute("aria-orientation")).toBe("vertical");
    expect(bar.getAttribute("aria-valuenow")).toBe("500");
    // Both sides keep the 448px column floor.
    expect(bar.getAttribute("aria-valuemin")).toBe("448");
    expect(bar.getAttribute("aria-valuemax")).toBe("552");
  });

  it("paints the drag onto the cells directly and commits the share once, on release", () => {
    const canvas = canvasWithTwoTiles();
    const { gutter, onResize } = renderGutter(canvas);
    const bar = screen.getByTestId(`chat-group-gutter-bar:${gutter.key}`);

    fireEvent.pointerDown(bar, { clientX: 500, pointerId: 1 });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 540 } as MouseEventInit));
    });
    // 540 of 1000 → the leading cell is 54% wide, the trailing one starts there.
    expect(canvas.querySelector<HTMLElement>('[data-testid="chat-group-cell:main"]')!.style.width).toBe("54%");
    expect(canvas.querySelector<HTMLElement>('[data-testid="chat-group-cell:group-2"]')!.style.left).toBe("54%");
    expect(onResize).not.toHaveBeenCalled();

    act(() => { window.dispatchEvent(new MouseEvent("pointerup")); });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize.mock.calls[0]![1]).toBeCloseTo(0.54);
  });

  it("offers no bar when the pair cannot hold two tiles at the floor", () => {
    const { gutter } = renderGutter(canvasWithTwoTiles(800));
    expect(screen.queryByTestId(`chat-group-gutter-bar:${gutter.key}`)).toBeNull();
  });
});
