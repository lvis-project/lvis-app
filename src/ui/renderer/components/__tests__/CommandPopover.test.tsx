// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { CommandPopover, type QuickAction } from "../CommandPopover.js";
import type { NativeContextMenuAction } from "../../../../shared/native-context-menu.js";

const DEFAULT_ACTIONS: QuickAction[] = [
  { id: "home",     label: "홈으로 이동",   run: vi.fn() },
  { id: "routines", label: "루틴 보기",     run: vi.fn() },
  { id: "settings", label: "설정 열기",     run: vi.fn() },
  { id: "new-chat", label: "새 대화 시작",  run: vi.fn() },
];

function renderPopover({
  actions = DEFAULT_ACTIONS,
  onInsert = vi.fn(),
  open = false,
  onOpenChange = vi.fn(),
}: Partial<Parameters<typeof CommandPopover>[0]> = {}) {
  return render(
    <TooltipProvider>
      <CommandPopover
        actions={actions}
        onInsert={onInsert}
        open={open}
        onOpenChange={onOpenChange}
      />
    </TooltipProvider>,
  );
}

describe("CommandPopover", () => {
  it("renders trigger button with data-testid=command-popover-trigger", () => {
    const { getByTestId } = renderPopover();
    expect(getByTestId("command-popover-trigger")).toBeTruthy();
  });

  it("shows popover content when open=true", async () => {
    renderPopover({ open: true });
    await waitFor(() => {
      expect(document.querySelector("[data-testid='command-popover']")).toBeTruthy();
    });
  });

  it("renders both section headings when open", async () => {
    renderPopover({ open: true });
    await waitFor(() => {
      expect(screen.getByText("빠른 실행")).toBeTruthy();
      expect(screen.getByText("슬래시 명령")).toBeTruthy();
    });
  });

  it("renders data-testid command-input when open", async () => {
    renderPopover({ open: true });
    await waitFor(() => {
      expect(document.querySelector("[data-testid='command-input']")).toBeTruthy();
    });
  });

  it("renders data-testid command-group-actions and command-group-slash when open", async () => {
    renderPopover({ open: true });
    await waitFor(() => {
      expect(document.querySelector("[data-testid='command-group-actions']")).toBeTruthy();
      expect(document.querySelector("[data-testid='command-group-slash']")).toBeTruthy();
    });
  });

  it("renders runnable slash commands when open", async () => {
    renderPopover({ open: true });
    const EXPECTED = [
      "/new", "/sessions", "/load", "/compact",
      "/remember", "/memory", "/vendor", "/tools",
      "/permission", "/permission dir list",
      "/permission mode strict", "/permission mode default", "/permission mode auto", "/permission mode allow",
      "/permission hooks list", "/permission audit verify", "/help",
    ];
    await waitFor(() => {
      const group = document.querySelector("[data-testid='command-group-slash']");
      expect(group).toBeTruthy();
      for (const cmd of EXPECTED) {
        expect(group!.textContent).toContain(cmd);
      }
      expect(group!.textContent).not.toContain("/permission mode권한 모드 변경");
    });
  });

  it("calls onInsert with slash command + space when slash item selected", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    const onOpenChange = vi.fn();
    renderPopover({ open: true, onInsert, onOpenChange });

    await waitFor(() => {
      expect(screen.getAllByText("/help").length).toBeGreaterThan(0);
    });

    // Click the /help item
    const helpItems = screen.getAllByText("/help");
    await act(async () => { await user.click(helpItems[0]); });
    expect(onInsert).toHaveBeenCalledWith("/help ");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls action.run() and closes popover when quick-action selected", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const onOpenChange = vi.fn();
    const actions: QuickAction[] = [{ id: "home", label: "홈으로 이동", run }];
    renderPopover({ open: true, actions, onOpenChange });

    await waitFor(() => {
      expect(screen.getByText("홈으로 이동")).toBeTruthy();
    });

    await act(async () => { await user.click(screen.getByText("홈으로 이동")); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("routes quick-action right-click through the native command menu", async () => {
    const previousLvis = window.lvis;
    let actionHandler: ((action: NativeContextMenuAction) => void) | null = null;
    const showNativeContextMenu = vi.fn(async () => ({ ok: true as const }));
    Object.defineProperty(window, "lvis", {
      configurable: true,
      value: {
        ...previousLvis,
        ui: {
          ...previousLvis?.ui,
          showNativeContextMenu,
          onNativeContextMenuAction: (handler: (action: NativeContextMenuAction) => void) => {
            actionHandler = handler;
            return () => { actionHandler = null; };
          },
        },
      },
    });

    const run = vi.fn();
    renderPopover({
      open: true,
      actions: [{ id: "home", label: "홈으로 이동", run }],
    });
    await waitFor(() => expect(screen.getByText("홈으로 이동")).toBeTruthy());
    const row = screen.getByText("홈으로 이동").closest<HTMLElement>("[cmdk-item]");
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row!);

    await waitFor(() => expect(showNativeContextMenu).toHaveBeenCalledOnce());
    const payload = showNativeContextMenu.mock.calls[0]![0];
    expect(payload).toMatchObject({
      kind: "command-item",
      commands: ["command.activate", "command.copy"],
    });
    act(() => {
      actionHandler?.({ requestId: payload.requestId, command: "command.activate" });
    });
    expect(run).toHaveBeenCalledOnce();

    Object.defineProperty(window, "lvis", { configurable: true, value: previousLvis });
  });

  it("hides empty groups when query filters out all items", async () => {
    const user = userEvent.setup();
    renderPopover({ open: true });

    await waitFor(() => {
      expect(document.querySelector("[data-testid='command-input']")).toBeTruthy();
    });

    const input = document.querySelector("[data-testid='command-input']") as HTMLInputElement;
    await act(async () => { await user.type(input, "zzznomatch"); });

    await waitFor(() => {
      // Both groups should be hidden (no matching items)
      expect(document.querySelector("[data-testid='command-group-actions']")).toBeNull();
      expect(document.querySelector("[data-testid='command-group-slash']")).toBeNull();
    });
  });

  it("closes popover on toggle trigger click when open", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { getByTestId } = renderPopover({ open: true, onOpenChange });

    // Click trigger to close
    await act(async () => { await user.click(getByTestId("command-popover-trigger")); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
