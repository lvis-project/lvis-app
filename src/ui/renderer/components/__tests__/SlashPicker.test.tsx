// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import type { NativeContextMenuAction } from "../../../../shared/native-context-menu.js";
import { SlashPicker } from "../SlashPicker.js";

const originalLvis = window.lvis;

afterEach(() => {
  Object.defineProperty(window, "lvis", { configurable: true, value: originalLvis });
});

describe("SlashPicker native context menu", () => {
  it("maps category navigation and slash command rows to native actions", async () => {
    let actionHandler: ((action: NativeContextMenuAction) => void) | null = null;
    const showNativeContextMenu = vi.fn(async () => ({ ok: true as const }));
    Object.defineProperty(window, "lvis", {
      configurable: true,
      value: {
        ...originalLvis,
        ui: {
          ...originalLvis?.ui,
          showNativeContextMenu,
          onNativeContextMenuAction: (handler: (action: NativeContextMenuAction) => void) => {
            actionHandler = handler;
            return () => { actionHandler = null; };
          },
        },
      },
    });

    const onInsert = vi.fn();
    render(
      <TooltipProvider>
        <SlashPicker
          actions={[]}
          plugins={[]}
          onSelectPlugin={vi.fn()}
          onInsert={onInsert}
          open
          onOpenChange={vi.fn()}
        />
      </TooltipProvider>,
    );

    const category = await screen.findByTestId("slash-picker-cat-command");
    fireEvent.contextMenu(category);
    await waitFor(() => expect(showNativeContextMenu).toHaveBeenCalledOnce());
    const categoryPayload = showNativeContextMenu.mock.calls[0]![0];
    expect(categoryPayload).toMatchObject({
      kind: "command-item",
      commands: ["command.activate", "command.copy"],
    });
    act(() => {
      actionHandler?.({ requestId: categoryPayload.requestId, command: "command.activate" });
    });

    const slashLabel = await screen.findByText("/new");
    const slashRow = slashLabel.closest<HTMLElement>("[cmdk-item]");
    expect(slashRow).toBeTruthy();
    fireEvent.contextMenu(slashRow!);
    await waitFor(() => expect(showNativeContextMenu).toHaveBeenCalledTimes(2));
    const slashPayload = showNativeContextMenu.mock.calls[1]![0];
    act(() => {
      actionHandler?.({ requestId: slashPayload.requestId, command: "command.activate" });
    });
    expect(onInsert).toHaveBeenCalledWith("/new ");
  });
});
