/**
 * MainToolbar unit tests.
 *
 * MainToolbar uses Tooltip which requires TooltipProvider — wrap every render.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { MainToolbar } from "../MainToolbar.js";

function defaultProps(overrides: Partial<Parameters<typeof MainToolbar>[0]> = {}) {
  return {
    activeView: "home",
    setActiveView: vi.fn(),
    pluginViews: [],
    starredCount: 0,
    streaming: false,
    hasApiKey: true as boolean | null,
    sessions: [],
    currentSessionId: "sess-1",
    sheetOpen: false,
    setSheetOpen: vi.fn(),
    onNewChat: vi.fn(),
    onRefreshSessions: vi.fn(),
    onLoadSession: vi.fn(),
    onExport: vi.fn(),
    onSearchToggle: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenCommand: vi.fn(),
    ...overrides,
  };
}

function renderWithProvider(props: Parameters<typeof MainToolbar>[0]) {
  return render(
    <TooltipProvider>
      <MainToolbar {...props} />
    </TooltipProvider>,
  );
}

describe("MainToolbar", () => {
  it("renders without crashing", () => {
    const { container } = renderWithProvider(defaultProps());
    expect(container).toBeTruthy();
  });

  it("renders default tabs: 홈, 태스크, 즐겨찾기", () => {
    const { getByText } = renderWithProvider(defaultProps());
    expect(getByText("홈")).toBeTruthy();
    expect(getByText("태스크")).toBeTruthy();
    expect(getByText("즐겨찾기")).toBeTruthy();
  });

  it("calls onNewChat when 새 대화 button clicked", () => {
    const onNewChat = vi.fn();
    const { getByText } = renderWithProvider(defaultProps({ onNewChat }));
    fireEvent.click(getByText("새 대화"));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("calls onSearchToggle when 찾기 button clicked", () => {
    const onSearchToggle = vi.fn();
    const { getByText } = renderWithProvider(defaultProps({ onSearchToggle }));
    fireEvent.click(getByText("찾기"));
    expect(onSearchToggle).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenSettings when 설정 button clicked", () => {
    const onOpenSettings = vi.fn();
    const { getByText } = renderWithProvider(defaultProps({ onOpenSettings }));
    fireEvent.click(getByText("설정"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("shows starred count badge when starredCount > 0", () => {
    const { container } = renderWithProvider(defaultProps({ starredCount: 3 }));
    expect(container.textContent).toContain("(3)");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
