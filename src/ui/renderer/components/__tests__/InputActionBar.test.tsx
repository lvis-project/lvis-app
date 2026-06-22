// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { InputActionBar } from "../InputActionBar.js";
import type { RolePreset } from "../../../../data/role-presets.js";
import type { AssistantContextMenuAction } from "../../../../shared/assistant-context-menu.js";

const mockPreset: RolePreset = { id: "default", name: "기본", systemPromptAdd: "" };
const codingPreset: RolePreset = { id: "coding", name: "코딩", systemPromptAdd: "Code carefully." };

function installNativeMenuMock() {
  const previous = (window as unknown as { lvis?: unknown }).lvis;
  let handler: ((action: AssistantContextMenuAction) => void) | null = null;
  const unsubscribe = vi.fn();
  const showAssistantContextMenu = vi.fn(async () => ({ ok: true as const }));
  const onAssistantContextAction = vi.fn((cb: (action: AssistantContextMenuAction) => void) => {
    handler = cb;
    return unsubscribe;
  });
  (window as unknown as { lvis?: unknown }).lvis = {
    ...(previous && typeof previous === "object" ? previous : {}),
    ui: { showAssistantContextMenu, onAssistantContextAction },
  };
  return {
    showAssistantContextMenu,
    emit: (action: AssistantContextMenuAction) => handler?.(action),
    restore: () => {
      if (previous === undefined) {
        delete (window as unknown as { lvis?: unknown }).lvis;
      } else {
        (window as unknown as { lvis?: unknown }).lvis = previous;
      }
    },
  };
}

function renderBar(overrides: Partial<Parameters<typeof InputActionBar>[0]> = {}) {
  const props: Parameters<typeof InputActionBar>[0] = {
    plugins: [],
    onSelectPlugin: vi.fn(),
    onInsertSlashCommand: vi.fn(),
    commandActions: [],
    commandPopoverOpen: false,
    onCommandPopoverOpenChange: vi.fn(),
    onAttach: vi.fn(),
    attachDisabled: false,
    rolePresets: [mockPreset],
    activePreset: mockPreset,
    activePresetId: "default",
    onSelectPreset: vi.fn(),
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <InputActionBar {...props} />
    </TooltipProvider>,
  );
}

describe("InputActionBar (post indexer-removal)", () => {
  it("renders with data-testid=input-action-bar", () => {
    const { getByTestId } = renderBar();
    expect(getByTestId("input-action-bar")).toBeTruthy();
  });

  it("has leading cluster with testid=iab-leading", () => {
    const { getByTestId } = renderBar();
    expect(getByTestId("iab-leading")).toBeTruthy();
  });

  it("has trailing cluster with testid=iab-trailing", () => {
    const { getByTestId } = renderBar();
    expect(getByTestId("iab-trailing")).toBeTruthy();
  });

  it("does NOT render the legacy indexer Paperclip popover trigger", () => {
    const { container } = renderBar();
    // The previous Paperclip-with-count trigger had `title="문서 첨부"`. After
    // removal there is no element bearing that title.
    expect(container.querySelector('[title="문서 첨부"]')).toBeNull();
  });

  it("does not render TokenProgressRing inside the plugin action bar", () => {
    const { getByTestId } = renderBar();
    const leading = getByTestId("iab-leading");
    expect(leading.querySelector("[data-testid='token-progress-ring']")).toBeNull();
  });

  it("renders PluginGridButton inside leading cluster", () => {
    const { getByTestId } = renderBar();
    const leading = getByTestId("iab-leading");
    expect(leading.querySelector("[data-testid='plugin-grid-button']")).toBeTruthy();
  });

  it("renders the unified slash-picker trigger inside leading cluster", () => {
    // The ⌘ CommandPopover was merged into the unified SlashPicker; its
    // trigger keeps the `command-popover-trigger` testid + the
    // command-palette-toggle tour anchor so existing wiring stays live.
    const { getByTestId } = renderBar();
    const leading = getByTestId("iab-leading");
    expect(leading.querySelector("[data-testid='command-popover-trigger']")).toBeTruthy();
  });

  it("no longer renders the inline Thinking checkbox (moved to BottomActionRow)", () => {
    // Thinking is now a dedicated ThinkingButton (toggle + depth) before Send
    // in the BottomActionRow, so the action bar must not carry the old inline
    // checkbox/label any more.
    const { queryByText, container } = renderBar({});
    expect(queryByText("Thinking")).toBeNull();
    expect(container.querySelector("[role='checkbox']")).toBeNull();
  });

  it("paperclip attach button calls onAttach when clicked and not disabled", () => {
    const onAttach = vi.fn();
    const { getByTestId } = renderBar({ onAttach, attachDisabled: false });
    const btn = getByTestId("iab-attach-button");
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it("paperclip attach button is disabled and does not call onAttach when attachDisabled=true", () => {
    const onAttach = vi.fn();
    const { getByTestId } = renderBar({ onAttach, attachDisabled: true });
    const btn = getByTestId("iab-attach-button");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("opens the assistant context picker through the native menu bridge", () => {
    const nativeMenu = installNativeMenuMock();
    try {
      const { getByTestId } = renderBar({
        rolePresets: [mockPreset, codingPreset],
        activePreset: codingPreset,
        activePresetId: "coding",
      });
      fireEvent.click(getByTestId("iab-assistant-context-button"));
      const payload = nativeMenu.showAssistantContextMenu.mock.calls[0]?.[0];
      expect(typeof payload.requestId).toBe("string");
      expect(typeof payload.x).toBe("number");
      expect(typeof payload.y).toBe("number");
      expect(nativeMenu.showAssistantContextMenu).toHaveBeenCalledWith(
        expect.objectContaining({
          personas: [
            { id: "default", name: "기본" },
            { id: "coding", name: "코딩" },
          ],
          activePersonaId: "coding",
        }),
      );
    } finally {
      nativeMenu.restore();
    }
  });

  it("opens the assistant context picker on right-click and prevents the DOM context menu", () => {
    const nativeMenu = installNativeMenuMock();
    try {
      const { getByTestId } = renderBar();
      const button = getByTestId("iab-assistant-context-button");
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 21,
        clientY: 34,
      });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(nativeMenu.showAssistantContextMenu).toHaveBeenCalledWith(
        expect.objectContaining({ x: 21, y: 34 }),
      );
    } finally {
      nativeMenu.restore();
    }
  });

  it("routes native persona actions back to the existing selector", () => {
    const nativeMenu = installNativeMenuMock();
    const onSelectPreset = vi.fn();
    try {
      const { getByTestId } = renderBar({
        rolePresets: [mockPreset, codingPreset],
        onSelectPreset,
      });
      fireEvent.click(getByTestId("iab-assistant-context-button"));
      const firstRequestId = nativeMenu.showAssistantContextMenu.mock.calls[0]?.[0]?.requestId;
      expect(typeof firstRequestId).toBe("string");

      nativeMenu.emit({ requestId: "other", kind: "persona", id: "ignored" });
      expect(onSelectPreset).not.toHaveBeenCalled();

      nativeMenu.emit({ requestId: firstRequestId, kind: "persona", id: "coding" });
      expect(onSelectPreset).toHaveBeenCalledWith("coding");
    } finally {
      nativeMenu.restore();
    }
  });

  it("keeps fixed trailing controls shrink-proof while permission slots clip first", () => {
    const { getByTestId } = renderBar({
      permissionSlot: <span data-testid="long-permission-slot">자동 검증 · 읽기 허용 · 매우 긴 권한 상태 텍스트</span>,
      approvalSlot: <span data-testid="long-approval-slot">승인 확인 실패 · 매우 긴 큐 상태 텍스트</span>,
    });
    expect(getByTestId("iab-trailing").className).toContain("overflow-hidden");
    expect(getByTestId("iab-permission-slots").className).toContain("min-w-0");
    expect(getByTestId("iab-permission-slots").className).toContain("overflow-hidden");
    expect(getByTestId("iab-assistant-context-button").className).toContain("shrink-0");
  });
});
