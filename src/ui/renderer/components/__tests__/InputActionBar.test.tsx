// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { InputActionBar } from "../InputActionBar.js";
import type { RolePreset } from "../../../../data/role-presets.js";
import type { AssistantContextMenuAction } from "../../../../shared/assistant-context-menu.js";
import type { InputStatusRow } from "../../hooks/use-input-status-row.js";

const mockPreset: RolePreset = { id: "default", name: "기본", systemPromptAdd: "" };
const codingPreset: RolePreset = { id: "coding", name: "코딩", systemPromptAdd: "Code carefully." };

// ThinkingButton (now part of the unified bar) reads its depth from the
// renderer api on mount.
const getSettings = vi.fn();
const updateSettings = vi.fn();
vi.mock("../../api-client.js", () => ({
  getApi: () => ({ getSettings, updateSettings }),
}));

const defaultStatusRow: InputStatusRow = {
  active: true,
  vendorModel: "OpenAI · gpt-5.4",
  permissionMode: "default",
  pendingApprovals: 0,
};

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
    ringSlot: <span data-testid="ring-slot" />,
    onAttach: vi.fn(),
    attachDisabled: false,
    rolePresets: [mockPreset],
    activePreset: mockPreset,
    activePresetId: "default",
    onSelectPreset: vi.fn(),
    isBusy: false,
    isSendDisabled: false,
    onSend: vi.fn(),
    onCancel: vi.fn(),
    enableThinkingChat: false,
    onToggleThinking: vi.fn(),
    statusRow: defaultStatusRow,
    contextPercent: 42,
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <InputActionBar {...props} />
    </TooltipProvider>,
  );
}

describe("InputActionBar (unified bar)", () => {
  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    getSettings.mockResolvedValue({
      llm: { provider: "azure-foundry", vendors: { "azure-foundry": { thinkingBudgetTokens: 10_000 } } },
    });
    updateSettings.mockResolvedValue({ ok: true });
  });

  it("renders with data-testid=input-action-bar and carries the tour anchor", () => {
    const { getByTestId } = renderBar();
    const root = getByTestId("input-action-bar");
    expect(root).toBeTruthy();
    expect(root.getAttribute("data-tour-anchor")).toBe("input-action-bar");
  });

  it("has leading + trailing clusters", () => {
    const { getByTestId } = renderBar();
    expect(getByTestId("iab-leading")).toBeTruthy();
    expect(getByTestId("iab-trailing")).toBeTruthy();
  });

  it("leading cluster order is [command] → [persona] → [attach] → [ring]", () => {
    const { getByTestId } = renderBar();
    const leading = getByTestId("iab-leading");
    const picker = leading.querySelector("[data-testid='command-popover-trigger']");
    const persona = leading.querySelector("[data-testid='iab-assistant-context-button']");
    const attach = leading.querySelector("[data-testid='iab-attach-button']");
    const ring = leading.querySelector("[data-testid='ring-slot']");
    expect(picker && persona && attach && ring).toBeTruthy();
    expect(picker!.compareDocumentPosition(persona!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(persona!.compareDocumentPosition(attach!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attach!.compareDocumentPosition(ring!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("trailing cluster order is [?] → [thinking] → [send]", () => {
    const { getByTestId } = renderBar();
    const trailing = getByTestId("iab-trailing");
    const help = trailing.querySelector("[data-testid='composer-shortcuts-button']");
    const thinking = trailing.querySelector("[data-testid='thinking-button']");
    const send = trailing.querySelector("[data-testid='composer-send-button']");
    expect(help && thinking && send).toBeTruthy();
    expect(help!.compareDocumentPosition(thinking!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(thinking!.compareDocumentPosition(send!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does NOT render the legacy PluginGridButton (plugins live in the sidebar + slash picker)", () => {
    const { container } = renderBar();
    expect(container.querySelector("[data-testid='plugin-grid-button']")).toBeNull();
  });

  it("attach button calls onAttach when clicked and not disabled", () => {
    const onAttach = vi.fn();
    const { getByTestId } = renderBar({ onAttach, attachDisabled: false });
    const btn = getByTestId("iab-attach-button");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it("attach button is disabled and does not call onAttach when attachDisabled=true", () => {
    const onAttach = vi.fn();
    const { getByTestId } = renderBar({ onAttach, attachDisabled: true });
    const btn = getByTestId("iab-attach-button");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("invokes onSend when Send is clicked", () => {
    const onSend = vi.fn();
    const { getByTestId } = renderBar({ onSend });
    fireEvent.click(getByTestId("composer-send-button"));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("shows the cancel button only while busy", () => {
    const { queryByTestId, rerender, getByTestId } = renderBar({ isBusy: false });
    expect(queryByTestId("composer-cancel-button")).toBeNull();
    rerender(
      <TooltipProvider>
        <InputActionBar
          plugins={[]}
          onSelectPlugin={vi.fn()}
          onInsertSlashCommand={vi.fn()}
          commandActions={[]}
          commandPopoverOpen={false}
          onCommandPopoverOpenChange={vi.fn()}
          ringSlot={<span data-testid="ring-slot" />}
          onAttach={vi.fn()}
          attachDisabled={false}
          rolePresets={[mockPreset]}
          activePreset={mockPreset}
          activePresetId="default"
          onSelectPreset={vi.fn()}
          isBusy
          isSendDisabled={false}
          onSend={vi.fn()}
          onCancel={vi.fn()}
          enableThinkingChat={false}
          onToggleThinking={vi.fn()}
          statusRow={defaultStatusRow}
          contextPercent={42}
        />
      </TooltipProvider>,
    );
    expect(getByTestId("composer-cancel-button")).not.toBeNull();
  });

  it("opens the shortcuts popover listing the composer shortcuts on click", async () => {
    const { getByTestId } = renderBar();
    fireEvent.click(getByTestId("composer-shortcuts-button"));
    await waitFor(() => {
      const popover = getByTestId("composer-shortcuts-popover");
      expect(popover.textContent).toContain("전송");
      expect(popover.textContent).toContain("줄바꿈");
    });
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
      nativeMenu.emit({ requestId: "other", kind: "persona", id: "ignored" });
      expect(onSelectPreset).not.toHaveBeenCalled();
      nativeMenu.emit({ requestId: firstRequestId, kind: "persona", id: "coding" });
      expect(onSelectPreset).toHaveBeenCalledWith("coding");
    } finally {
      nativeMenu.restore();
    }
  });

  // ── Status sub-row ──────────────────────────────────────────────────────
  it("renders the status sub-row with model + permission + context-percent", () => {
    const { getByTestId } = renderBar();
    const row = getByTestId("iab-status-row");
    expect(row).toBeTruthy();
    expect(getByTestId("iab-status-model").textContent).toContain("OpenAI · gpt-5.4");
    expect(getByTestId("iab-status-context").textContent).toContain("42%");
  });

  it("colors the permission text per mode (no pill/outline)", () => {
    const cases: Array<[InputStatusRow["permissionMode"], string]> = [
      ["default", "text-info"],
      ["strict", "text-destructive"],
      ["auto", "text-warning"],
      ["allow", "text-success"],
    ];
    for (const [mode, cls] of cases) {
      const { getByTestId, unmount } = renderBar({
        statusRow: { ...defaultStatusRow, permissionMode: mode },
      });
      const perm = getByTestId("iab-status-permission");
      expect(perm.className).toContain(cls);
      // No pill/outline (border-*) classes on the bare-text permission cell.
      expect(perm.className).not.toContain("border-");
      expect(perm.getAttribute("data-mode")).toBe(mode);
      unmount();
    }
  });

  it("dims the context-percent and shows an em-dash when no live token data", () => {
    const { getByTestId } = renderBar({ contextPercent: null });
    const ctx = getByTestId("iab-status-context");
    expect(ctx.textContent).toContain("—");
    expect(ctx.className).toContain("opacity-40");
  });

  it("renders the active-state dot green when active, muted when inactive", () => {
    const { getByTestId, unmount } = renderBar({
      statusRow: { ...defaultStatusRow, active: true },
    });
    expect(getByTestId("iab-status-active-dot").className).toContain("bg-success");
    unmount();
    const { getByTestId: getByTestId2 } = renderBar({
      statusRow: { ...defaultStatusRow, active: false },
    });
    expect(getByTestId2("iab-status-active-dot").className).not.toContain("bg-success");
  });

  it("appends the pending-approval count to the permission text", () => {
    const { getByTestId } = renderBar({
      statusRow: { ...defaultStatusRow, permissionMode: "auto", pendingApprovals: 2 },
    });
    expect(getByTestId("iab-status-permission").textContent).toContain("2");
  });
});
