import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { PANE_CELL_INSET, PANE_MIN_HEIGHT, PANE_MIN_WIDTH, PaneFrame, PaneGutter, buildChatGroupActions, chatGroupApi, usePanePanelSlot, useChatGroups, type PanePanelSlot } from "../PaneFrame.js";
import { layoutBoxes, layoutGutters, leaf, leafIds, resizeGutter, splitLeaf, type PaneGutter as PaneGutterShape } from "../pane-tree.js";
import { MAX_CHAT_GROUPS, MAX_PANES } from "../../../../contract/app-contract.js";
import { CHAT_SESSION_DRAG_TYPE } from "../pane-drop.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../../shared/side-panel.js";
import type { LvisApi } from "../../types.js";

const t = ((key: string) => key) as never;

function pane(props: Partial<React.ComponentProps<typeof PaneFrame>> = {}) {
  return (
    <TooltipProvider>
      <PaneFrame title="a" {...props}>
        {props.children ?? <div>body</div>}
      </PaneFrame>
    </TooltipProvider>
  );
}

describe("PaneFrame", () => {
  afterEach(cleanup);

  it("renders a titled header with no actions, no trailing controls, no close, and no maximize", () => {
    render(pane({ title: "Routines" }));
    expect(screen.getByTestId("pane-header").textContent).toBe("Routines");
    expect(screen.queryByTestId("pane-close")).toBeNull();
    expect(screen.queryByTestId("pane-maximize")).toBeNull();
    expect(screen.queryByTestId("pane-split")).toBeNull();
    expect(screen.queryByTestId("pane-panel-slot")).toBeNull();
  });

  it("draws the icon ahead of the title", () => {
    render(pane({ title: "Routines", icon: <svg data-testid="pane-icon" /> }));
    const header = screen.getByTestId("pane-header");
    const icon = screen.getByTestId("pane-icon");
    const title = header.querySelector("h2")!;
    expect(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("carries the content's actions and fires them", () => {
    const onSelect = vi.fn();
    render(pane({ actions: [{ id: "view.new", label: "New", icon: <span />, onSelect }] }));
    fireEvent.click(screen.getByTestId("pane-action-view.new"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("puts trailing controls at the head of the trailing cluster, ahead of maximize and close", () => {
    render(pane({
      trailing: <button type="button" data-testid="pane-trailing">t</button>,
      onToggleMaximize: vi.fn(),
      onClose: vi.fn(),
    }));
    const cluster = screen.getByTestId("pane-trailing").parentElement!;
    const ids = Array.from(cluster.children).map((child) => child.getAttribute("data-testid"));
    expect(ids).toEqual(["pane-trailing", "pane-maximize", "pane-close"]);
  });

  it("offers close only when given one, and maximize only when given one", () => {
    const onClose = vi.fn();
    const onToggleMaximize = vi.fn();
    const view = render(pane({ onClose }));
    fireEvent.click(screen.getByTestId("pane-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("pane-maximize")).toBeNull();

    view.rerender(pane({ onToggleMaximize, maximized: true }));
    expect(screen.queryByTestId("pane-close")).toBeNull();
    const maximize = screen.getByTestId("pane-maximize");
    expect(maximize.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(maximize);
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("names closing after the pane, unless the caller says what is really being closed", () => {
    const view = render(pane({ onClose: vi.fn() }));
    expect(screen.getByTestId("pane-close").getAttribute("aria-label")).toBe("패널 닫기");

    // A routed pane's close puts the pane back on its conversation rather than
    // removing it, so the label names the view instead of the pane.
    view.rerender(pane({ onClose: vi.fn(), closeLabel: "Close Routines" }));
    expect(screen.getByTestId("pane-close").getAttribute("aria-label")).toBe("Close Routines");
  });

  it("insets the body for a page and not for a conversation", () => {
    const view = render(pane({ bodyInset: "none" }));
    const body = () => view.container.querySelector("[data-body-inset]")!;
    expect(body().getAttribute("data-body-inset")).toBe("none");
    expect(body().className).not.toContain("p-4");

    view.rerender(pane({ bodyInset: "page" }));
    expect(body().getAttribute("data-body-inset")).toBe("page");
    expect(body().className).toContain("p-4");
  });

  it("defaults the body to no inset", () => {
    const view = render(pane());
    expect(view.container.querySelector("[data-body-inset]")!.getAttribute("data-body-inset")).toBe("none");
  });

  it("swaps the border on focus without changing the frame's size", () => {
    const view = render(pane());
    const frame = () => view.container.querySelector('[data-testid="pane"]')!;
    expect(frame().className).toContain("border-border");
    expect(frame().className).not.toContain("border-primary");
    expect(frame().getAttribute("data-focused")).toBeNull();

    view.rerender(pane({ focused: true }));
    expect(frame().className).toContain("border-primary");
    expect(frame().className).not.toMatch(/\bborder-border\b/);
    expect(frame().getAttribute("data-focused")).toBe("true");
  });

  it("drops a two-way split choice — beside or under — instead of guessing from the tile's shape", () => {
    const onSplit = vi.fn();
    const splitFits = vi.fn((axis: "row" | "column") => axis === "row");
    render(pane({ onSplit, splitFits }));
    fireEvent.click(screen.getByTestId("pane-split"));
    expect(onSplit).not.toHaveBeenCalled();
    const choice = screen.getByTestId("pane-split-choice");
    // A direction the floors cannot afford is offered disabled, not hidden.
    expect((screen.getByTestId("pane-split-column") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("pane-split-row"));
    expect(onSplit).toHaveBeenCalledWith("row");
    expect(choice.isConnected).toBe(false);
  });

  it("does not take focus back from the new tile after a direction is chosen", () => {
    render(pane({ onSplit: vi.fn() }));
    const trigger = screen.getByTestId("pane-split");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("pane-split-row"));
    // The popover's close would normally return focus to its trigger — inside
    // THIS tile, whose focus capture would then undo the new tile's focus.
    expect(document.activeElement).not.toBe(trigger);
  });

  it("says why when neither direction fits, instead of offering two dead buttons", () => {
    render(pane({ onSplit: vi.fn(), splitFits: () => false }));
    fireEvent.click(screen.getByTestId("pane-split"));
    const reason = screen.getByTestId("pane-split-no-room").textContent ?? "";
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).not.toBe("pane.splitNoRoom");
    expect(screen.queryByTestId("pane-split-row")).toBeNull();
    expect(screen.queryByTestId("pane-split-column")).toBeNull();
  });

  it("publishes the aside slot only when asked", () => {
    const seen: ReturnType<typeof usePanePanelSlot>[] = [];
    function Probe() {
      seen.push(usePanePanelSlot());
      return null;
    }
    const view = render(pane({ children: <Probe /> }));
    expect(seen.at(-1)).toBeNull();

    view.rerender(pane({ asideSlot: true, children: <Probe /> }));
    expect(seen.at(-1)?.panel).toBe(screen.getByTestId("pane-panel-slot"));
    expect(seen.at(-1)?.tile).toBe(view.container.querySelector('[data-testid="pane"]'));
  });

  it("publishes no panel slot outside a frame, and inside one before the slot element commits", () => {
    const seen: Array<PanePanelSlot | null> = [];
    function Probe() {
      seen.push(usePanePanelSlot());
      return null;
    }
    render(<Probe />);
    expect(seen).toEqual([null]);

    seen.length = 0;
    render(pane({ asideSlot: true, children: <Probe /> }));
    // The first render already says "inside a frame" — an object, not null —
    // so a view can hold its panel back until the slot element is there.
    expect(seen[0]).toEqual({ panel: null, tile: null });
    expect(seen[seen.length - 1]!.panel).toBe(screen.getByTestId("pane-panel-slot"));
  });

  it("lends the work panel a slot beside the body column, tall as the tile", () => {
    render(pane({ asideSlot: true }));
    const slot = screen.getByTestId("pane-panel-slot");
    const header = screen.getByTestId("pane-header");
    // The slot is the tile's own child, a sibling of the column that holds the
    // header — not a descendant of it — so a panel there stands beside the
    // header rather than under it.
    expect(slot.parentElement).toBe(header.parentElement!.parentElement);
    expect(slot.contains(header)).toBe(false);
  });

  it("does not render a conversation list of its own — that is the window's sidebar", () => {
    render(pane({ asideSlot: true }));
    expect(screen.queryByTestId("pane-sidebar")).toBeNull();
    expect(screen.queryByTestId("pane-sidebar-toggle")).toBeNull();
  });
});

describe("buildChatGroupActions", () => {
  afterEach(cleanup);

  it("carries the conversation's own actions in the pane header", () => {
    const onTogglePin = vi.fn();
    const onImport = vi.fn();
    render(pane({
      actions: buildChatGroupActions({
        t,
        pinned: false,
        onTogglePin,
        onExport: vi.fn(),
        onImport,
      }),
    }));
    fireEvent.click(screen.getByTestId("pane-action-conversation.pin"));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("pane-action-conversation.import"));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("names the pin action by what the click will do, so a pinned row offers unpin", () => {
    render(pane({
      actions: buildChatGroupActions({
        t,
        pinned: true,
        onTogglePin: vi.fn(),
        onExport: vi.fn(),
        onImport: vi.fn(),
      }),
    }));
    const unpin = screen.getByTestId("pane-action-conversation.unpin");
    expect(unpin.getAttribute("aria-label")).toBe("mainToolbar.sessionUnstar");
    expect(unpin.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("pane-action-conversation.pin")).toBeNull();
  });
});

describe("PaneFrame drop gesture", () => {
  afterEach(cleanup);

  const TILE = { left: 0, top: 0, width: 800, height: 600 };

  function tileWithRect(props: Partial<React.ComponentProps<typeof PaneFrame>>) {
    const view = render(pane(props));
    const tile = view.container.querySelector('[data-testid="pane"]')!;
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

  it("shows the drop indicator while a conversation is dragged over it, and clears it on the drop", () => {
    const onSessionDrop = vi.fn();
    const tile = tileWithRect({ onSessionDrop, canSplit: true });

    expect(screen.queryByTestId("pane-drop-indicator")).toBeNull();
    drag("dragOver", tile, carriedSession, { x: 795, y: 300 });
    expect(screen.getByTestId("pane-drop-indicator")).toBeTruthy();
    expect(tile.getAttribute("data-drop-target")).toBe("right");

    drag("drop", tile, carriedSession, { x: 795, y: 300 });
    expect(onSessionDrop).toHaveBeenCalledWith("session-7", "right");
    expect(screen.queryByTestId("pane-drop-indicator")).toBeNull();
  });

  it("takes no drop when it has no receiver", () => {
    const tile = tileWithRect({});
    drag("dragOver", tile, carriedSession, { x: 795, y: 300 });
    expect(tile.getAttribute("data-drop-target")).toBeNull();
    expect(screen.queryByTestId("pane-drop-indicator")).toBeNull();
  });

  it("collapses every edge to the centre once no tile fits, so the ceiling is felt before the drop", () => {
    const onSessionDrop = vi.fn();
    const tile = tileWithRect({ onSessionDrop, canSplit: false });

    drag("dragOver", tile, carriedSession, { x: 795, y: 300 });
    expect(tile.getAttribute("data-drop-target")).toBe("center");

    drag("drop", tile, carriedSession, { x: 795, y: 300 });
    expect(onSessionDrop).toHaveBeenCalledWith("session-7", "center");
  });

  it("demotes an edge drop the floors cannot afford to the centre, the same rule the split control states", () => {
    const onSessionDrop = vi.fn();
    const tile = tileWithRect({ onSessionDrop, canSplit: true, splitFits: (axis) => axis === "column" });

    drag("dragOver", tile, carriedSession, { x: 795, y: 300 });
    expect(tile.getAttribute("data-drop-target")).toBe("center");
    drag("dragOver", tile, carriedSession, { x: 400, y: 5 });
    expect(tile.getAttribute("data-drop-target")).toBe("top");

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

describe("useChatGroups", () => {
  afterEach(cleanup);

  it("starts with the one group whose conversation loop actually exists", () => {
    const { result } = renderHook(() => useChatGroups());
    expect(result.current.groups.map((group) => group.id)).toEqual(["main"]);
    expect(result.current.focusedId).toBe("main");
  });

  it("halves a tile on the axis the user chose, the new tile trailing", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "column"));
    expect(result.current.tree).toMatchObject({ kind: "split", axis: "column" });
    expect(result.current.groups.map((group) => group.id)).toEqual(["main", "group-2"]);
    expect(result.current.focusedId).toBe("group-2");
    act(() => result.current.split("group-2", "row"));
    expect(result.current.groups.map((group) => group.id)).toEqual(["main", "group-2", "group-3"]);
  });

  it("says which split directions the floors still afford", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    // Roomy on both axes.
    expect(result.current.splitFits("main", "row", { width: 1000, height: 1000 })).toBe(true);
    expect(result.current.splitFits("main", "column", { width: 1000, height: 1000 })).toBe(true);
    // Each axis at its own boundary, written out in absolute px. These are the
    // anchors: a half is measured after losing PANE_CELL_INSET, so the
    // tightest canvas that still splits is 2*(floor + inset) — 916 wide against
    // the 448 width floor, 580 tall against the 280 height floor. Because they
    // are literals, a change to PANE_FRAME_BORDER (and so to the inset)
    // moves the boundary and fails here, which a derived expectation could not
    // catch: it would move with the implementation.
    expect(result.current.splitFits("main", "row", { width: 916, height: 1000 })).toBe(true);
    expect(result.current.splitFits("main", "row", { width: 915, height: 1000 })).toBe(false);
    expect(result.current.splitFits("main", "column", { width: 1000, height: 580 })).toBe(true);
    expect(result.current.splitFits("main", "column", { width: 1000, height: 579 })).toBe(false);
    // The same two boundaries derived from the constants, so the anchors above
    // are readable as arithmetic rather than as magic numbers.
    expect(2 * (PANE_MIN_WIDTH + PANE_CELL_INSET)).toBe(916);
    expect(2 * (PANE_MIN_HEIGHT + PANE_CELL_INSET)).toBe(580);
    // A canvas under BOTH floors fails on either axis.
    expect(result.current.splitFits("main", "row", { width: 800, height: 400 })).toBe(false);
    expect(result.current.splitFits("main", "column", { width: 800, height: 400 })).toBe(false);
    // Unmeasured: nothing to check against.
    expect(result.current.splitFits("main", "row", undefined)).toBe(true);
    // After a side-by-side split each half is 500 of 1000 — a second split beside no longer fits.
    act(() => result.current.split("main", "row"));
    expect(result.current.splitFits("main", "row", { width: 1000, height: 1000 })).toBe(false);
  });

  it("sets aside an idle group at the ceiling — never the primary, the focused, or the target", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));
    act(() => result.current.split("group-2", "row"));
    act(() => result.current.split("group-3", "row"));
    expect(result.current.groups.map((group) => group.id))
      .toEqual(["main", "group-2", "group-3", "group-4"]);

    // Every group idle, so only the exclusions can decide which one goes.
    act(() => result.current.focus("group-3"));
    let adopted: { chatGroupId: string; released: string | null } | null = null;
    act(() => { adopted = result.current.adopt("group-2", () => true, undefined); });

    // "group-4" is the only leaf that is none of: the group being adopted
    // beside, the focused group, the primary. Each of those three exclusions
    // would name a different leaf here if it were dropped.
    expect(adopted).toMatchObject({ released: "group-4" });
    expect(result.current.groups.map((group) => group.id))
      .toEqual(["main", "group-2", "group-5", "group-3"]);
  });

  it("refuses rather than take a busy group, and leaves the tree untouched", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));
    act(() => result.current.split("group-2", "row"));
    act(() => result.current.split("group-3", "row"));
    act(() => result.current.focus("group-3"));
    const before = result.current.groups.map((group) => group.id);

    let adopted: { chatGroupId: string; released: string | null } | null = null;
    act(() => {
      adopted = result.current.adopt("group-2", (id) => id !== "group-4", undefined);
    });

    expect(adopted).toBeNull();
    expect(result.current.groups.map((group) => group.id)).toEqual(before);
  });

  it("adopts without maximizing in chat mode, where the canvas is never split", () => {
    // A canvas far under the split floors. Work mode has nowhere to draw both,
    // so it shows the newcomer alone; chat mode draws one tile whatever the
    // tree holds, and a maximize set here would only surface — wrongly — the
    // moment the user toggled to work mode.
    const tooSmall = { width: 400, height: 300 };

    const work = renderHook(() => useChatGroups("work"));
    act(() => work.result.current.split("main", "row"));
    act(() => { work.result.current.adopt("main", () => true, tooSmall); });
    expect(work.result.current.maximizedId).toBe("group-3");

    const chat = renderHook(() => useChatGroups("chat"));
    act(() => chat.result.current.split("main", "row"));
    act(() => { chat.result.current.adopt("main", () => true, tooSmall); });
    expect(chat.result.current.maximizedId).toBeNull();
  });

  it("reveals the tile it focuses, so a maximize follows rather than hides it", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));
    act(() => result.current.toggleMaximize("main"));
    expect(result.current.maximizedId).toBe("main");

    // Focusing the other tile while one is maximized used to move focus alone:
    // every focus-derived surface followed, and the screen did not.
    act(() => result.current.focus("group-2"));
    expect(result.current.focusedId).toBe("group-2");
    expect(result.current.maximizedId).toBe("group-2");
    expect(result.current.groups.filter((group) => !group.hidden).map((group) => group.id))
      .toEqual(["group-2"]);

    // With nothing maximized, focus is focus and both tiles stay drawn.
    act(() => result.current.toggleMaximize("group-2"));
    act(() => result.current.focus("main"));
    expect(result.current.maximizedId).toBeNull();
    expect(result.current.groups.filter((group) => !group.hidden).map((group) => group.id))
      .toEqual(["main", "group-2"]);
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

describe("useChatGroups pane content", () => {
  afterEach(cleanup);

  it("opens every pane on its own conversation", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    expect(result.current.contentById).toEqual({ main: { view: "home" } });
    expect([...result.current.conversationIds]).toEqual(["main"]);

    act(() => result.current.split("main", "row"));
    // A pane opened by a split is a conversation pane, exactly as before: the
    // gesture that makes it is still "put a conversation here".
    expect(result.current.contentById).toEqual({
      main: { view: "home" },
      "group-2": { view: "home" },
    });
    expect([...result.current.conversationIds]).toEqual(["main", "group-2"]);
  });

  it("moves ONE pane's content, leaving its neighbour where it was", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));

    act(() => result.current.setPaneContent("main", { view: "routines" }));
    expect(result.current.contentById["main"]).toEqual({ view: "routines" });
    expect(result.current.contentById["group-2"]).toEqual({ view: "home" });
    // The pane keeps its conversation while a view is drawn over it — the
    // transcript is hidden, not taken away.
    expect(result.current.conversationIds.has("main")).toBe(true);

    act(() => result.current.setPaneContent("main", { view: "home" }));
    expect(result.current.contentById["main"]).toEqual({ view: "home" });
  });

  it("reads the window's location off whichever pane has focus", () => {
    // This IS the `activeView` derivation: the window is where the FOCUSED
    // pane is, so focusing the other pane moves the window's location without
    // either pane's content changing.
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));
    act(() => result.current.setPaneContent("main", { view: "work-board" }));
    const activeView = () => result.current.contentById[result.current.focusedId]?.view;

    expect(result.current.focusedId).toBe("group-2");
    expect(activeView()).toBe("home");
    act(() => result.current.focus("main"));
    expect(activeView()).toBe("work-board");
  });

  it("focuses the pane a non-home view is already open in rather than opening a second", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));
    act(() => result.current.setPaneContent("main", { view: "insights" }));
    act(() => result.current.focus("group-2"));

    act(() => result.current.setPaneContent("group-2", { view: "insights" }));
    expect(result.current.focusedId).toBe("main");
    expect(result.current.contentById["group-2"]).toEqual({ view: "home" });

    // Home is exempt — a pane's home is its OWN conversation, not a shared
    // place, so two panes on home is the normal state and not a duplicate.
    act(() => result.current.focus("group-2"));
    act(() => result.current.setPaneContent("group-2", { view: "home" }));
    expect(result.current.focusedId).toBe("group-2");
  });

  it("focuses the pane a plugin is already open in rather than opening a second guest", () => {
    // The plugin case is the one with a cost beyond redundancy: two panes on
    // one `plugin:<id>:<viewId>` are two <webview> guests in the SAME session
    // partition, so they share cookies, storage and the host's per-webContents
    // plugin registration while disagreeing about the plugin's state.
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));
    act(() => result.current.setPaneContent("main", { view: "plugin:meeting:control" }));
    act(() => result.current.focus("group-2"));

    act(() => result.current.setPaneContent("group-2", { view: "plugin:meeting:control" }));
    expect(result.current.focusedId).toBe("main");
    expect(result.current.contentById["group-2"]).toEqual({ view: "home" });

    // A DIFFERENT view of the same plugin is a different place, and opens where
    // it was asked for.
    act(() => result.current.focus("group-2"));
    act(() => result.current.setPaneContent("group-2", { view: "plugin:meeting:notes" }));
    expect(result.current.focusedId).toBe("group-2");
    expect(result.current.contentById["group-2"]).toEqual({ view: "plugin:meeting:notes" });
  });

  it("counts conversations and panes as two ceilings, and gives both back on close", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));
    act(() => result.current.split("group-2", "row"));
    act(() => result.current.split("group-3", "row"));

    // Four panes, four conversations: MAX_PANES counts the leaves, and
    // MAX_CHAT_GROUPS counts the conversation set. Both are full, so the
    // gesture stops offering a fifth and the drop refuses one.
    expect(leafIds(result.current.tree)).toHaveLength(MAX_PANES);
    expect(result.current.conversationIds.size).toBe(MAX_CHAT_GROUPS);
    expect(result.current.canSplit).toBe(false);
    let created: string | null = "not-called";
    act(() => { created = result.current.dropOnEdge("main", "right"); });
    expect(created).toBeNull();

    // Closing gives back one of each, so the next drop is allowed again.
    act(() => result.current.close("group-4"));
    expect(leafIds(result.current.tree)).toHaveLength(3);
    expect([...result.current.conversationIds]).toEqual(["main", "group-2", "group-3"]);
    expect(result.current.contentById["group-4"]).toBeUndefined();
    expect(result.current.canSplit).toBe(true);
  });

  it("releases the spare's conversation along with its pane", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));
    act(() => result.current.split("group-2", "row"));
    act(() => result.current.split("group-3", "row"));
    act(() => result.current.focus("group-3"));

    act(() => { result.current.adopt("group-2", () => true, undefined); });
    // "group-4" was set aside: it must leave the conversation set too, or the
    // ceiling would count a loop main no longer holds.
    expect(result.current.conversationIds.has("group-4")).toBe(false);
    expect(result.current.contentById["group-4"]).toBeUndefined();
    expect(result.current.conversationIds.size).toBe(MAX_CHAT_GROUPS);
    expect([...result.current.conversationIds].includes("group-5")).toBe(true);
  });

  it("opens a pane beside the focused one and gives back its id", () => {
    // The sidebar's "open in a new pane" makes the SAME pane the header's split
    // makes — a conversation pane, focused — and hands the id back so the
    // caller can put a view in it.
    const { result } = renderHook(() => useChatGroups("work"));
    let opened: string | null = "not-called";
    act(() => { opened = result.current.openPane("main", undefined); });

    expect(opened).toBe("group-2");
    expect(leafIds(result.current.tree)).toEqual(["main", "group-2"]);
    expect(result.current.focusedId).toBe("group-2");
    expect(result.current.conversationIds.has("group-2")).toBe(true);
    expect(result.current.contentById["group-2"]).toEqual({ view: "home" });
  });

  it("refuses a new pane once the canvas is full, without opening one", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    act(() => result.current.split("main", "row"));
    act(() => result.current.split("group-2", "row"));
    act(() => result.current.split("group-3", "row"));
    expect(leafIds(result.current.tree)).toHaveLength(MAX_PANES);

    let opened: string | null = "not-called";
    act(() => { opened = result.current.openPane("main", undefined); });
    expect(opened).toBeNull();
    // A refusal that still added a pane would be worse than no refusal at all.
    expect(leafIds(result.current.tree)).toHaveLength(MAX_PANES);
  });

  it("refuses a new pane the width cannot carry — the split's own floor", () => {
    // No second rule for this gesture: `splitFits` is asked exactly as the
    // header's split control asks it, so a canvas too narrow to halve refuses
    // both the same way.
    const { result } = renderHook(() => useChatGroups("work"));
    const tooNarrow = { width: (PANE_MIN_WIDTH + PANE_CELL_INSET) * 2 - 1, height: 900 };

    expect(result.current.splitFits("main", "row", tooNarrow)).toBe(false);
    let opened: string | null = "not-called";
    act(() => { opened = result.current.openPane("main", tooNarrow); });
    expect(opened).toBeNull();
    expect(leafIds(result.current.tree)).toEqual(["main"]);

    // One pixel wider and both halves clear the floor, so both say yes.
    const wideEnough = { width: (PANE_MIN_WIDTH + PANE_CELL_INSET) * 2, height: 900 };
    act(() => { opened = result.current.openPane("main", wideEnough); });
    expect(opened).toBe("group-2");
  });

  it("refuses a new pane in chat mode, which draws one and hides the rest", () => {
    const { result } = renderHook(() => useChatGroups("chat"));
    let opened: string | null = "not-called";
    act(() => { opened = result.current.openPane("main", undefined); });
    expect(opened).toBeNull();
    expect(leafIds(result.current.tree)).toEqual(["main"]);
  });

  it("names the conversation pane focus is on, and never one that is gone", () => {
    const { result } = renderHook(() => useChatGroups("work"));
    expect(result.current.focusedConversationId).toBe("main");

    act(() => result.current.split("main", "row"));
    expect(result.current.focusedConversationId).toBe("group-2");
    act(() => result.current.focus("main"));
    expect(result.current.focusedConversationId).toBe("main");

    // The remembered pane can be closed out from under the binding; the answer
    // falls back to a pane that still holds a conversation.
    act(() => result.current.close("main"));
    expect(result.current.focusedConversationId).toBe("group-2");
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

/** The groups the view actually draws — the rest stay mounted but hidden. */
function drawn(groups: readonly { id: string; hidden: boolean }[]): string[] {
  return groups.filter((group) => !group.hidden).map((group) => group.id);
}

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
    // One tile DRAWN, both groups still mounted: the other conversation may be
    // mid-turn, and a turn's stream subscription lives in its tile. Chat mode
    // hides it rather than taking it away.
    // The split focused the new group, and chat mode draws the focused one.
    expect(drawn(result.current.groups)).toEqual(["group-2"]);
    expect(result.current.groups.map((group) => group.id)).toEqual(["main", "group-2"]);
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
    expect(drawn(result.current.groups)).toEqual(["group-2"]);
    expect(result.current.gutters).toEqual([]);
    // Still two tiles, both mounted: the view changed, not the workspace.
    expect(result.current.groups.map((group) => group.id)).toEqual(["main", "group-2"]);
    expect(result.current.closable).toBe(true);

    act(() => result.current.toggleMaximize("group-2"));
    expect(result.current.maximizedId).toBeNull();
    expect(drawn(result.current.groups)).toEqual(["main", "group-2"]);
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

describe("PaneGutter", () => {
  afterEach(cleanup);

  /** A canvas holding two tiles side by side, split down the middle. */
  function canvasWithTwoTiles(width = 1000) {
    const canvas = document.createElement("div");
    Object.defineProperty(canvas, "clientWidth", { value: width });
    Object.defineProperty(canvas, "clientHeight", { value: 700 });
    for (const id of ["main", "group-2"]) {
      const cell = document.createElement("div");
      cell.setAttribute("data-testid", `pane-cell:${id}`);
      canvas.appendChild(cell);
    }
    document.body.appendChild(canvas);
    return canvas;
  }

  function renderGutter(canvas: HTMLElement, onResize = vi.fn()) {
    const tree = splitLeaf(leaf("main"), "main", "right", "group-2");
    const [gutter] = layoutGutters(tree);
    const previewResize = (g: PaneGutterShape, share: number) => {
      const next = resizeGutter(tree, g, share);
      return { boxes: layoutBoxes(next), gutters: layoutGutters(next) };
    };
    const view = render(
      <TooltipProvider>
        <PaneGutter
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
    const bar = screen.getByTestId(`pane-gutter-bar:${gutter.key}`);
    expect(bar.getAttribute("role")).toBe("separator");
    // A width-resizing bar stands vertical; its value is the leading tile's px.
    expect(bar.getAttribute("aria-orientation")).toBe("vertical");
    expect(bar.getAttribute("aria-valuenow")).toBe("500");
    // Both sides keep the 448px column floor.
    expect(bar.getAttribute("aria-valuemin")).toBe(String(SIDE_PANEL_MIN_WIDTH));
    expect(bar.getAttribute("aria-valuemax")).toBe("552");
  });

  it("paints the drag onto the cells directly and commits the share once, on release", () => {
    const canvas = canvasWithTwoTiles();
    const { gutter, onResize } = renderGutter(canvas);
    const bar = screen.getByTestId(`pane-gutter-bar:${gutter.key}`);

    fireEvent.pointerDown(bar, { clientX: 500, pointerId: 1 });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 540 } as MouseEventInit));
    });
    // 540 of 1000 → the leading cell is 54% wide, the trailing one starts there.
    expect(canvas.querySelector<HTMLElement>('[data-testid="pane-cell:main"]')!.style.width).toBe("54%");
    expect(canvas.querySelector<HTMLElement>('[data-testid="pane-cell:group-2"]')!.style.left).toBe("54%");
    expect(onResize).not.toHaveBeenCalled();

    act(() => { window.dispatchEvent(new MouseEvent("pointerup")); });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize.mock.calls[0]![1]).toBeCloseTo(0.54);
  });

  it("offers no bar when the pair cannot hold two tiles at the floor", () => {
    const { gutter } = renderGutter(canvasWithTwoTiles(800));
    expect(screen.queryByTestId(`pane-gutter-bar:${gutter.key}`)).toBeNull();
  });
});
