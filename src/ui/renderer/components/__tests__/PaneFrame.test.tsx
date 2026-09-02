import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { PaneFrame, useChatGroupPanelSlot } from "../ChatGroupFrame.js";
import { CHAT_SESSION_DRAG_TYPE } from "../chat-group-drop.js";

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
    expect(screen.getByTestId("chat-group-header").textContent).toBe("Routines");
    expect(screen.queryByTestId("chat-group-close")).toBeNull();
    expect(screen.queryByTestId("chat-group-maximize")).toBeNull();
    expect(screen.queryByTestId("chat-group-split")).toBeNull();
    expect(screen.queryByTestId("chat-group-panel-slot")).toBeNull();
  });

  it("draws the icon ahead of the title", () => {
    render(pane({ title: "Routines", icon: <svg data-testid="pane-icon" /> }));
    const header = screen.getByTestId("chat-group-header");
    const icon = screen.getByTestId("pane-icon");
    const title = header.querySelector("h2")!;
    expect(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("carries the content's actions and fires them", () => {
    const onSelect = vi.fn();
    render(pane({ actions: [{ id: "view.new", label: "New", icon: <span />, onSelect }] }));
    fireEvent.click(screen.getByTestId("chat-group-action-view.new"));
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
    expect(ids).toEqual(["pane-trailing", "chat-group-maximize", "chat-group-close"]);
  });

  it("offers close only when given one, and maximize only when given one", () => {
    const onClose = vi.fn();
    const onToggleMaximize = vi.fn();
    const view = render(pane({ onClose }));
    fireEvent.click(screen.getByTestId("chat-group-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("chat-group-maximize")).toBeNull();

    view.rerender(pane({ onToggleMaximize, maximized: true }));
    expect(screen.queryByTestId("chat-group-close")).toBeNull();
    const maximize = screen.getByTestId("chat-group-maximize");
    expect(maximize.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(maximize);
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
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
    const frame = () => view.container.querySelector('[data-testid="chat-group"]')!;
    expect(frame().className).toContain("border-border");
    expect(frame().className).not.toContain("border-primary");
    expect(frame().getAttribute("data-focused")).toBeNull();

    view.rerender(pane({ focused: true }));
    expect(frame().className).toContain("border-primary");
    expect(frame().className).not.toMatch(/\bborder-border\b/);
    expect(frame().getAttribute("data-focused")).toBe("true");
  });

  it("publishes the aside slot only when asked", () => {
    const seen: ReturnType<typeof useChatGroupPanelSlot>[] = [];
    function Probe() {
      seen.push(useChatGroupPanelSlot());
      return null;
    }
    const view = render(pane({ children: <Probe /> }));
    expect(seen.at(-1)).toBeNull();

    view.rerender(pane({ asideSlot: true, children: <Probe /> }));
    expect(seen.at(-1)?.panel).toBe(screen.getByTestId("chat-group-panel-slot"));
    expect(seen.at(-1)?.tile).toBe(view.container.querySelector('[data-testid="chat-group"]'));
  });

  it("shows the drop indicator while a conversation is dragged over it and reports where it landed", () => {
    const onSessionDrop = vi.fn();
    const view = render(pane({ onSessionDrop, canSplit: true }));
    const tile = view.container.querySelector('[data-testid="chat-group"]')!;
    const rect = { left: 0, top: 0, width: 800, height: 600 };
    tile.getBoundingClientRect = () => ({
      ...rect, right: rect.width, bottom: rect.height, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    const carried = { types: [CHAT_SESSION_DRAG_TYPE], getData: () => "session-7", dropEffect: "none" };
    const drag = (kind: "dragOver" | "drop", point: { x: number; y: number }) => {
      const event = createEvent[kind](tile, { dataTransfer: carried });
      Object.defineProperty(event, "clientX", { value: point.x });
      Object.defineProperty(event, "clientY", { value: point.y });
      fireEvent(tile, event);
    };

    expect(screen.queryByTestId("chat-group-drop-indicator")).toBeNull();
    drag("dragOver", { x: 795, y: 300 });
    expect(screen.getByTestId("chat-group-drop-indicator")).toBeTruthy();
    expect(tile.getAttribute("data-drop-target")).toBe("right");

    drag("drop", { x: 795, y: 300 });
    expect(onSessionDrop).toHaveBeenCalledWith("session-7", "right");
    expect(screen.queryByTestId("chat-group-drop-indicator")).toBeNull();
  });

  it("takes no drop when it has no receiver", () => {
    const view = render(pane());
    const tile = view.container.querySelector('[data-testid="chat-group"]')!;
    const carried = { types: [CHAT_SESSION_DRAG_TYPE], getData: () => "session-7", dropEffect: "none" };
    fireEvent(tile, createEvent.dragOver(tile, { dataTransfer: carried }));
    expect(tile.getAttribute("data-drop-target")).toBeNull();
    expect(screen.queryByTestId("chat-group-drop-indicator")).toBeNull();
  });
});
