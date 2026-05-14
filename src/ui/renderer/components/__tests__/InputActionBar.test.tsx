// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { InputActionBar } from "../InputActionBar.js";
import type { RolePreset } from "../../../../data/role-presets.js";

const mockPreset: RolePreset = { id: "default", name: "기본", systemPromptAdd: "" };

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
    vendorSupportsThinking: false,
    enableThinkingChat: false,
    onToggleThinking: vi.fn(),
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

  it("renders CommandPopover trigger inside leading cluster", () => {
    const { getByTestId } = renderBar();
    const leading = getByTestId("iab-leading");
    expect(leading.querySelector("[data-testid='command-popover-trigger']")).toBeTruthy();
  });

  it("renders thinking checkbox when vendorSupportsThinking=true", () => {
    const { getByText } = renderBar({ vendorSupportsThinking: true, enableThinkingChat: false });
    expect(getByText("Thinking")).toBeTruthy();
  });

  it("renders thinking checkbox even when vendor does not support thinking — engine ignores the flag", () => {
    // Previously gated by `vendorSupportsThinking`. The toggle is now
    // always visible: vendors that don't support thinking simply ignore
    // the flag at the engine layer, but the UI surface is consistent
    // across LLM models.
    const { getByText } = renderBar({ vendorSupportsThinking: false });
    expect(getByText("Thinking")).toBeTruthy();
  });

  it("uses the shadcn checkbox affordance for Thinking", () => {
    const { getByRole } = renderBar({ enableThinkingChat: false });
    const checkbox = getByRole("checkbox", { name: "Thinking" });
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
    expect(checkbox.className).toContain("rounded-[2px]");
    expect(checkbox.className).toContain("bg-background");
    expect(checkbox.className).toContain("data-[state=unchecked]:bg-background");
    expect(checkbox.className).not.toContain("bg-white");
    expect(checkbox.className).not.toContain("appearance-auto");
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
});
