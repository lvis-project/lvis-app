// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { InputActionBar } from "../InputActionBar.js";
import type { RolePreset } from "../../../../data/role-presets.js";
import type { AssistantContextMenuAction } from "../../../../shared/assistant-context-menu.js";
import type { InputStatusRow } from "../../hooks/use-input-status-row.js";
import { TEST_IDS, testIdSelector } from "../../../../shared/test-ids.js";

const mockPreset: RolePreset = { id: "default", name: "기본", systemPromptAdd: "" };
const codingPreset: RolePreset = { id: "coding", name: "코딩", systemPromptAdd: "Code carefully." };

// ThinkingButton (now part of the unified bar) reads its depth from the
// renderer api on mount.
const getSettings = vi.fn();
const updateSettings = vi.fn();
const onSettingsUpdated = vi.fn(() => () => {});
const subscriptionUseApiForChat = vi.fn(async () => ({ ok: true }));
vi.mock("../../api-client.js", () => ({
  getApi: () => ({ getSettings, updateSettings, onSettingsUpdated, subscriptionUseApiForChat }),
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
    hasDraft: false,
    onSend: vi.fn(),
    onCancel: vi.fn(),
    enableThinkingChat: false,
    onToggleThinking: vi.fn(),
    statusRow: defaultStatusRow,
    onOpenModelSettings: vi.fn(),
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

  it("leading cluster order is [command] → [persona] → [attach] (ring moved to status row)", () => {
    const { getByTestId } = renderBar();
    const leading = getByTestId("iab-leading");
    const picker = leading.querySelector(testIdSelector(TEST_IDS.commandPopoverTrigger));
    const persona = leading.querySelector("[data-testid='iab-assistant-context-button']");
    const attach = leading.querySelector("[data-testid='iab-attach-button']");
    expect(picker && persona && attach).toBeTruthy();
    expect(picker!.compareDocumentPosition(persona!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(persona!.compareDocumentPosition(attach!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The ring is NO LONGER in the leading action cluster.
    expect(leading.querySelector("[data-testid='ring-slot']")).toBeNull();
  });

  it("trailing cluster order is [?] → [send] (reasoning moved to the status row)", () => {
    const { getByTestId } = renderBar();
    const trailing = getByTestId("iab-trailing");
    const help = trailing.querySelector("[data-testid='composer-shortcuts-button']");
    const send = trailing.querySelector("[data-testid='composer-send-button']");
    expect(help && send).toBeTruthy();
    expect(help!.compareDocumentPosition(send!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Reasoning/thinking is no longer in the trailing cluster — it is the
    // status sub-row chip after the model cell (and opens the model card).
    expect(trailing.querySelector("[data-testid='thinking-button']")).toBeNull();
    const statusRow = getByTestId("iab-status-row");
    expect(statusRow.querySelector("[data-testid='iab-status-reasoning']")).toBeTruthy();
    expect(statusRow.querySelector("[data-testid='iab-status-reasoning'] svg")).toBeTruthy();
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

  // The turn control is ONE button, not a send button beside a cancel button.
  // Which verb it carries is decided by the draft, not by `isBusy` alone.
  it("idle with an empty draft keeps a single disabled send button", () => {
    const { getByTestId, queryByTestId } = renderBar({
      isBusy: false,
      hasDraft: false,
      isSendDisabled: true,
    });
    expect(queryByTestId("composer-cancel-button")).toBeNull();
    const send = getByTestId("composer-send-button") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    // A disabled SOLID primary is a near-black disc at 50% opacity — the grey
    // blob this redesign is replacing. With nothing to send the control goes
    // quiet instead, matching the outline treatment of the leading cluster.
    expect(send.className).toContain("bg-input-bar-subtle");
    expect(send.className).not.toContain("bg-primary");
  });

  it("goes quiet for a runtime block too, not just for an empty draft", () => {
    // `isSendDisabled` also folds in the runtime blocks (no API key, runtime
    // unavailable). The button cannot act in those states either, so it must
    // not sit there as a disabled SOLID disc — the quiet treatment and the
    // `disabled` attribute are driven by the same flag and cannot disagree.
    const { getByTestId } = renderBar({
      isBusy: false,
      hasDraft: true,
      isSendDisabled: true,
    });
    const send = getByTestId("composer-send-button") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.className).toContain("bg-input-bar-subtle");
  });

  it("busy with an empty draft turns the one button into stop", () => {
    const onCancel = vi.fn();
    const onSend = vi.fn();
    const { getByTestId, queryByTestId } = renderBar({
      isBusy: true,
      hasDraft: false,
      isSendDisabled: true,
      onCancel,
      onSend,
    });
    expect(queryByTestId("composer-send-button")).toBeNull();
    const stop = getByTestId("composer-cancel-button") as HTMLButtonElement;
    // Stop stays clickable even though sending is blocked by the empty draft,
    // and it is solid — it is the one thing the user can act on right now.
    expect(stop.disabled).toBe(false);
    expect(stop.className).toContain("bg-primary");
    fireEvent.click(stop);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("typing during a run flips the stop button back to send", () => {
    const onCancel = vi.fn();
    const onSend = vi.fn();
    const { getByTestId, queryByTestId } = renderBar({
      isBusy: true,
      hasDraft: true,
      isSendDisabled: false,
      onCancel,
      onSend,
    });
    expect(queryByTestId("composer-cancel-button")).toBeNull();
    fireEvent.click(getByTestId("composer-send-button"));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("the turn control carries no text label — icon plus accessible name only", () => {
    const { getByTestId } = renderBar({ hasDraft: true, isSendDisabled: false });
    const send = getByTestId("composer-send-button");
    // The old markup shipped a "전송" span plus a ⏎ keycap whose background and
    // text both resolved to `primary-foreground`, so the glyph read as an
    // empty box. Nothing but the icon may live inside the button now.
    expect(send.textContent?.trim()).toBe("");
    expect(send.querySelector("kbd")).toBeNull();
    expect(send.querySelector("svg")).not.toBeNull();
    expect(send.getAttribute("aria-label")).toBeTruthy();
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
  it("renders the status sub-row in reversed order: ring (left) before permission · model · dot", () => {
    const { getByTestId } = renderBar();
    const row = getByTestId("iab-status-row");
    expect(row).toBeTruthy();
    expect(getByTestId("iab-status-model").textContent).toContain("gpt-5.4");
    expect(getByTestId("iab-status-model").querySelector("svg")).toBeTruthy();
    // The TokenProgressRing widget now lives in the status row.
    const ringHost = getByTestId("iab-status-ring");
    expect(ringHost.querySelector("[data-testid='ring-slot']")).toBeTruthy();
    // …positioned BEFORE the permission cell (reversed row: ring is leftmost).
    const permission = getByTestId("iab-status-permission");
    expect(permission.compareDocumentPosition(ringHost) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // The separate context-percent text cell is gone.
    expect(row.querySelector("[data-testid='iab-status-context']")).toBeNull();
  });

  it("names the model alone in the status row, and keeps the vendor in the accessible name", () => {
    const { getByTestId } = renderBar();
    const model = getByTestId("iab-status-model");
    expect(model.textContent).toContain("gpt-5.4");
    expect(model.textContent).not.toContain("OpenAI");
    // Hover and screen reader still get the whole route.
    expect(model.getAttribute("title")).toBe("OpenAI · gpt-5.4");
    expect(model.getAttribute("aria-label")).toBe("OpenAI · gpt-5.4");
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

  it("renders the pending-approval count as a SEPARATE button before the permission cell", () => {
    const { getByTestId } = renderBar({
      statusRow: { ...defaultStatusRow, permissionMode: "auto", pendingApprovals: 2 },
    });
    // The count is its own button now — NOT appended to the permission label.
    expect(getByTestId("iab-status-pending").textContent).toContain("2");
    expect(getByTestId("iab-status-permission").textContent).not.toContain("2");
    // …and it precedes the permission cell.
    const pending = getByTestId("iab-status-pending");
    const permission = getByTestId("iab-status-permission");
    expect(pending.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getByTestId("permission-pending-badge").textContent).toContain("2");
  });

  it("opens the deferred approval queue from the pending-approval button", () => {
    const onOpenApprovalQueue = vi.fn();
    const onOpenPermissions = vi.fn();
    const { getByTestId } = renderBar({
      statusRow: { ...defaultStatusRow, permissionMode: "auto", pendingApprovals: 2 },
      onOpenApprovalQueue,
      onOpenPermissions,
    });
    fireEvent.click(getByTestId("iab-status-pending"));
    expect(onOpenApprovalQueue).toHaveBeenCalledTimes(1);
    expect(onOpenPermissions).not.toHaveBeenCalled();
  });
});


describe("model card (status-row model cell)", () => {
  /** Settings where two models are pinned and offered, and one pinned id is offered by nothing. */
  const settingsWithPins = () => ({
    llm: {
      provider: "openai-compatible",
      activeChatRuntime: { kind: "api" },
      vendors: {
        "openai-compatible": { model: "qwen3.8-27b-gguf", enableThinking: true, thinkingBudgetTokens: 10_000, baseUrl: "http://llm.example.test/v1" },
        claude: { model: "claude-sonnet-4-6", enableThinking: true, thinkingBudgetTokens: 10_000 },
      },
      streamSmoothing: "none",
      fallbackChain: [],
      modelListCache: {
        "openai-compatible\nhttp://llm.example.test/v1\n": {
          vendor: "openai-compatible",
          baseUrl: "http://llm.example.test/v1",
          endpoint: "http://llm.example.test/v1/models",
          models: ["qwen3.8-27b-gguf", "qwen3.8-27b-nvfp4"],
          fetchedAt: "2026-08-27T00:00:00.000Z",
        },
      },
      pinnedModels: ["qwen3.8-27b-nvfp4", "qwen3.8-27b-gguf", "gone-from-every-catalogue"],
    },
  });

  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    subscriptionUseApiForChat.mockClear();
    getSettings.mockResolvedValue(settingsWithPins());
    updateSettings.mockResolvedValue({});
  });

  it("names the vendor in the card, where the status row no longer says it", async () => {
    // The literal the catalogue holds for this vendor, not the same lookup the
    // component makes — a derived expectation would agree with a wrong label.
    // The suite renders in Korean (src/i18n/testing/vitest-ambient-intl.ts).
    const vendorLabel = "사용자 지정 (OpenAI 호환)";
    const { getByTestId, findByTestId } = renderBar({ onOpenModelSettings: vi.fn() });
    fireEvent.click(getByTestId("iab-status-model"));
    const card = await findByTestId("model-quick-picker");
    await waitFor(() => expect(card.querySelectorAll("[role='option']").length).toBe(2));
    const current = card.querySelector("[role='option'][aria-selected='true']");
    expect(current?.textContent).toContain(vendorLabel);
    expect(current?.textContent).toContain("qwen3.8-27b-gguf");
  });

  it("opens the card instead of leaving for Settings", async () => {
    const onOpenModelSettings = vi.fn();
    const { getByTestId, findByTestId } = renderBar({ onOpenModelSettings });
    fireEvent.click(getByTestId("iab-status-model"));
    expect(await findByTestId("model-quick-picker")).toBeTruthy();
    expect(onOpenModelSettings).not.toHaveBeenCalled();
  });

  it("the reasoning chip is a second way into the same card, and goes with reasoning", async () => {
    const onOpenModelSettings = vi.fn();
    const { getByTestId, findByTestId, queryByTestId, unmount } = renderBar({ onOpenModelSettings, enableThinkingChat: true });
    const chip = getByTestId("iab-status-reasoning");
    expect(chip.getAttribute("data-level")).not.toBe("0");
    fireEvent.click(chip);
    expect(await findByTestId("model-quick-picker")).toBeTruthy();
    expect(queryByTestId("reasoning-popover")).toBeNull();
    expect(onOpenModelSettings).not.toHaveBeenCalled();
    unmount();
    const without = renderBar({ onOpenModelSettings, reasoningAvailable: false });
    expect(without.queryByTestId("iab-status-reasoning")).toBeNull();
    expect(without.getByTestId("iab-status-model")).toBeTruthy();
  });

  it("lists the pinned models only — in pinned order, and none that nothing offers", async () => {
    const { getByTestId, findByTestId } = renderBar({ onOpenModelSettings: vi.fn() });
    fireEvent.click(getByTestId("iab-status-model"));
    const card = await findByTestId("model-quick-picker");
    await waitFor(() => expect(card.querySelectorAll("[role='option']").length).toBe(2));
    const ids = [...card.querySelectorAll("[role='option'] button")].map((b) => b.getAttribute("data-testid"));
    expect(ids).toEqual([
      "model-quick-picker-option:openai-compatible:qwen3.8-27b-nvfp4",
      "model-quick-picker-option:openai-compatible:qwen3.8-27b-gguf",
    ]);
    // The one the chat is on is marked as such.
    expect(card.querySelector("[role='option'][aria-selected='true'] button")?.getAttribute("data-testid"))
      .toBe("model-quick-picker-option:openai-compatible:qwen3.8-27b-gguf");
  });

  it("persists a pick at once and closes", async () => {
    const { getByTestId, findByTestId, queryByTestId } = renderBar({ onOpenModelSettings: vi.fn() });
    fireEvent.click(getByTestId("iab-status-model"));
    const card = await findByTestId("model-quick-picker");
    const option = await waitFor(() => {
      const el = card.querySelector<HTMLButtonElement>("[data-testid='model-quick-picker-option:openai-compatible:qwen3.8-27b-nvfp4']");
      if (!el) throw new Error("not yet");
      return el;
    });
    fireEvent.click(option);
    expect(updateSettings).toHaveBeenCalledWith({
      llm: {
        provider: "openai-compatible",
        vendors: { "openai-compatible": { model: "qwen3.8-27b-nvfp4" } },
      },
    });
    // Already on the API path: no runtime switch is sent.
    await waitFor(() => expect(queryByTestId("model-quick-picker")).toBeNull());
    expect(subscriptionUseApiForChat).not.toHaveBeenCalled();
  });

  it("also leaves a subscription runtime for the API path when a pin is chosen", async () => {
    getSettings.mockResolvedValue({
      ...settingsWithPins(),
      llm: { ...settingsWithPins().llm, activeChatRuntime: { kind: "subscription", provider: "codex" } },
    });
    const { getByTestId, findByTestId } = renderBar({ onOpenModelSettings: vi.fn() });
    fireEvent.click(getByTestId("iab-status-model"));
    const card = await findByTestId("model-quick-picker");
    const option = await waitFor(() => {
      const el = card.querySelector<HTMLButtonElement>("[data-testid='model-quick-picker-option:openai-compatible:qwen3.8-27b-nvfp4']");
      if (!el) throw new Error("not yet");
      return el;
    });
    fireEvent.click(option);
    expect(updateSettings).toHaveBeenCalledWith({
      llm: {
        provider: "openai-compatible",
        vendors: { "openai-compatible": { model: "qwen3.8-27b-nvfp4" } },
      },
    });
    await waitFor(() => expect(subscriptionUseApiForChat).toHaveBeenCalledTimes(1));
  });

  it("checks the subscription provider — not an API model — while a subscription runtime is active", async () => {
    getSettings.mockResolvedValue({
      ...settingsWithPins(),
      llm: { ...settingsWithPins().llm, activeChatRuntime: { kind: "subscription", provider: "codex" } },
    });
    const { getByTestId, findByTestId } = renderBar({ onOpenModelSettings: vi.fn() });
    fireEvent.click(getByTestId("iab-status-model"));
    const card = await findByTestId("model-quick-picker");
    await waitFor(() => expect(card.querySelectorAll("[role='option']").length).toBe(3));
    const checked = card.querySelectorAll("[role='option'][aria-selected='true']");
    expect(checked).toHaveLength(1);
    expect(checked[0]?.querySelector("button")?.getAttribute("data-testid")).toBe("model-quick-picker-option:codex");
    expect(checked[0]?.textContent).toContain("Codex");
    // The API model that happens to share the settings the API path still
    // holds (vendor "openai-compatible", model "qwen3.8-27b-gguf") is listed
    // as an alternative, not marked as the route the chat is actually on.
    expect(
      card
        .querySelector("[data-testid='model-quick-picker-option:openai-compatible:qwen3.8-27b-gguf']")
        ?.closest("[role='option']")
        ?.getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("disables the subscription row — it is a marker, not a pick, and stays out of the tab order", async () => {
    getSettings.mockResolvedValue({
      ...settingsWithPins(),
      llm: { ...settingsWithPins().llm, activeChatRuntime: { kind: "subscription", provider: "codex" } },
    });
    const { getByTestId, findByTestId } = renderBar({ onOpenModelSettings: vi.fn() });
    fireEvent.click(getByTestId("iab-status-model"));
    const card = await findByTestId("model-quick-picker");
    const button = await waitFor(() => {
      const el = card.querySelector<HTMLButtonElement>("[data-testid='model-quick-picker-option:codex']");
      if (!el) throw new Error("not yet");
      return el;
    });
    expect(button.disabled).toBe(true);
    // A disabled button never dispatches a click — nothing to guard against
    // in the pick handler.
    fireEvent.click(button);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(subscriptionUseApiForChat).not.toHaveBeenCalled();
  });

  it("names the subscription provider in the primary column when the runtime has no model of its own", async () => {
    getSettings.mockResolvedValue({
      ...settingsWithPins(),
      llm: { ...settingsWithPins().llm, activeChatRuntime: { kind: "subscription", provider: "kimi-code" } },
    });
    const { getByTestId, findByTestId } = renderBar({ onOpenModelSettings: vi.fn() });
    fireEvent.click(getByTestId("iab-status-model"));
    const card = await findByTestId("model-quick-picker");
    const option = await waitFor(() => {
      const el = card.querySelector<HTMLButtonElement>("[data-testid='model-quick-picker-option:kimi-code']");
      if (!el) throw new Error("not yet");
      return el;
    });
    const spans = option.querySelectorAll("span");
    // The muted vendor column would otherwise be the only place the label
    // appears, leaving the primary column visually empty — the label moves
    // there instead when the runtime has no model of its own.
    expect(spans[0]?.textContent).toBe("");
    expect(spans[1]?.textContent).toBe("Kimi Code");
  });

  it("carries the reasoning control and the way to the full catalogue", async () => {
    const onOpenModelSettings = vi.fn();
    const { getByTestId, findByTestId } = renderBar({ onOpenModelSettings });
    fireEvent.click(getByTestId("iab-status-model"));
    const card = await findByTestId("model-quick-picker");
    expect(card.querySelector("[data-testid='model-quick-picker-reasoning'] [data-testid='reasoning-range']")).toBeTruthy();
    fireEvent.click(card.querySelector("[data-testid='model-quick-picker-more']")!);
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1);
  });

  it("still lists the current model when nothing is pinned, and says where to pin", async () => {
    getSettings.mockResolvedValue({ ...settingsWithPins(), llm: { ...settingsWithPins().llm, pinnedModels: [] } });
    const { getByTestId, findByTestId, queryByTestId } = renderBar({ onOpenModelSettings: vi.fn() });
    fireEvent.click(getByTestId("iab-status-model"));
    const card = await findByTestId("model-quick-picker");
    await waitFor(() => expect(card.querySelectorAll("[role='option']").length).toBe(1));
    expect(card.querySelector("[role='option'][aria-selected='true'] button")?.getAttribute("data-testid"))
      .toBe("model-quick-picker-option:openai-compatible:qwen3.8-27b-gguf");
    expect(await findByTestId("model-quick-picker-no-pins")).toBeTruthy();
    // With pins, the hint is not there.
    getSettings.mockResolvedValue(settingsWithPins());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(queryByTestId("model-quick-picker")).toBeNull());
    fireEvent.click(getByTestId("iab-status-model"));
    const reopened = await findByTestId("model-quick-picker");
    await waitFor(() => expect(reopened.querySelectorAll("[role='option']").length).toBe(2));
    expect(queryByTestId("model-quick-picker-no-pins")).toBeNull();
  });
});
