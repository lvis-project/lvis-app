// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { InputActionBar } from "../InputActionBar.js";
import type { RolePreset } from "../../../../data/role-presets.js";

const mockPreset: RolePreset = { id: "default", name: "기본", systemPrompt: "" };

function renderBar(overrides: Partial<Parameters<typeof InputActionBar>[0]> = {}) {
  const props: Parameters<typeof InputActionBar>[0] = {
    usedTokens: 500,
    contextBudget: 1000,
    plugins: [],
    onSelectPlugin: vi.fn(),
    onInsertSlashCommand: vi.fn(),
    attachedDocs: [],
    onToggleAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    indexedDocs: [],
    docsLoading: false,
    onRefreshDocs: vi.fn(),
    docPopoverOpen: false,
    onDocPopoverOpenChange: vi.fn(),
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

describe("InputActionBar", () => {
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

  it("renders TokenProgressRing inside leading cluster", () => {
    const { getByTestId } = renderBar();
    const leading = getByTestId("iab-leading");
    expect(leading.querySelector("[data-testid='token-progress-ring']")).toBeTruthy();
  });

  it("renders PluginGridButton inside leading cluster", () => {
    const { getByTestId } = renderBar();
    const leading = getByTestId("iab-leading");
    expect(leading.querySelector("[data-testid='plugin-grid-button']")).toBeTruthy();
  });

  it("renders SlashCommandButton inside leading cluster", () => {
    const { getByTestId } = renderBar();
    const leading = getByTestId("iab-leading");
    expect(leading.querySelector("[data-testid='slash-command-button']")).toBeTruthy();
  });

  it("renders thinking checkbox when vendorSupportsThinking=true", () => {
    const { getByText } = renderBar({ vendorSupportsThinking: true, enableThinkingChat: false });
    expect(getByText("Thinking")).toBeTruthy();
  });

  it("does not render thinking checkbox when vendorSupportsThinking=false", () => {
    const { queryByText } = renderBar({ vendorSupportsThinking: false });
    expect(queryByText("Thinking")).toBeNull();
  });
});
