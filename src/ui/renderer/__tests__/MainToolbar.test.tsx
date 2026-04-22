import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { MainToolbar } from "../MainToolbar.js";

function defaultProps(overrides: Partial<Parameters<typeof MainToolbar>[0]> = {}) {
  return {
    streaming: false,
    hasApiKey: true as boolean | null,
    sessions: [],
    currentSessionId: "sess-1",
    isCurrentSessionStarred: false,
    onNewChat: vi.fn(),
    onRefreshSessions: vi.fn(),
    onRefreshStarred: vi.fn(),
    onLoadSession: vi.fn(),
    onToggleCurrentSessionStar: vi.fn(),
    onToggleSessionStar: vi.fn(),
    isSessionStarred: vi.fn(() => false),
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
  it("renders action buttons", () => {
    const { getByText } = renderWithProvider(defaultProps());
    expect(getByText("새 대화")).toBeTruthy();
    expect(getByText("기록")).toBeTruthy();
    expect(getByText("세션")).toBeTruthy();
    expect(getByText("내보내기")).toBeTruthy();
    expect(getByText("찾기")).toBeTruthy();
    expect(getByText("설정")).toBeTruthy();
    expect(getByText("Cmd")).toBeTruthy();
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

  it("calls onToggleCurrentSessionStar when current session star clicked", () => {
    const onToggleCurrentSessionStar = vi.fn();
    const { getByText } = renderWithProvider(defaultProps({ onToggleCurrentSessionStar }));
    fireEvent.click(getByText("세션"));
    expect(onToggleCurrentSessionStar).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
