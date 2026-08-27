import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ChatGroupFrame, buildChatGroupActions } from "../ChatGroupFrame.js";

const t = ((key: string) => key) as never;

describe("ChatGroupFrame", () => {
  afterEach(cleanup);

  it("names the conversation on the leading edge of its own header", () => {
    render(
      <TooltipProvider><ChatGroupFrame title="전체 동기화로 상태 파악" actions={[]} panelOpen={false} onTogglePanel={vi.fn()}>
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    expect(screen.getByTestId("chat-group-header").textContent).toContain("전체 동기화로 상태 파악");
  });

  it("expresses focus on the frame, not on the content", () => {
    const view = render(
      <TooltipProvider><ChatGroupFrame title="a" actions={[]} panelOpen={false} onTogglePanel={vi.fn()}>
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    expect(
      view.container.querySelector('[data-testid="chat-group"]')?.getAttribute("data-focused"),
    ).toBeNull();
    view.rerender(
      <TooltipProvider><ChatGroupFrame title="a" focused actions={[]} panelOpen={false} onTogglePanel={vi.fn()}>
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
        panelOpen={false}
        onTogglePanel={vi.fn()}
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
        panelOpen={false}
        onTogglePanel={vi.fn()}
      >
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    const unpin = screen.getByTestId("chat-group-action-conversation.unpin");
    expect(unpin.getAttribute("aria-label")).toBe("mainToolbar.sessionUnstar");
    expect(unpin.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("chat-group-action-conversation.pin")).toBeNull();
  });

  it("owns the work panel toggle — each group has its own panel", () => {
    const onTogglePanel = vi.fn();
    render(
      <TooltipProvider><ChatGroupFrame title="a" actions={[]} panelOpen onTogglePanel={onTogglePanel}>
        <div>body</div>
      </ChatGroupFrame></TooltipProvider>,
    );
    const toggle = screen.getByTestId("chat-group-panel-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(onTogglePanel).toHaveBeenCalledTimes(1);
  });
});
