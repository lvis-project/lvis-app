import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    onOpenSettings: vi.fn(),
    onOpenGlobalSearch: vi.fn(),
    onOpenStarredView: vi.fn(),
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

/** Open the hamburger menu dropdown via pointerDown (Radix UI trigger) */
async function openHamburger() {
  const hamburger = screen.getByTitle("더 많은 메뉴");
  fireEvent.pointerDown(hamburger);
  // Wait for dropdown items to appear (rendered into document.body portal)
  await waitFor(() => expect(screen.queryByText("설정")).toBeTruthy());
}

describe("MainToolbar", () => {
  it("renders 새 대화 button and hamburger trigger", () => {
    renderWithProvider(defaultProps());
    expect(screen.getByText("새 대화")).toBeTruthy();
    expect(screen.getByTitle("더 많은 메뉴")).toBeTruthy();
    // TokenProgressRing is now in InputActionBar, not MainToolbar
    expect(document.querySelector("[data-testid='token-progress-ring']")).toBeNull();
  });

  it("calls onNewChat when 새 대화 button clicked", () => {
    const onNewChat = vi.fn();
    renderWithProvider(defaultProps({ onNewChat }));
    fireEvent.click(screen.getByText("새 대화"));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenGlobalSearch when global search button clicked", () => {
    const onOpenGlobalSearch = vi.fn();
    renderWithProvider(defaultProps({ onOpenGlobalSearch }));
    fireEvent.click(screen.getByTitle("전체 검색 (메모리·세션·즐겨찾기)"));
    expect(onOpenGlobalSearch).toHaveBeenCalledTimes(1);
  });

  it("hamburger does not contain 대화 검색 item (moved to InputActionBar)", async () => {
    renderWithProvider(defaultProps());
    await openHamburger();
    expect(screen.queryByText("대화 검색")).toBeNull();
  });

  it("calls onOpenStarredView when 즐겨찾기 보기 menu item clicked", async () => {
    const onOpenStarredView = vi.fn();
    renderWithProvider(defaultProps({ onOpenStarredView }));
    await openHamburger();
    fireEvent.click(screen.getByText("즐겨찾기 보기"));
    expect(onOpenStarredView).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenSettings when 설정 menu item clicked", async () => {
    const onOpenSettings = vi.fn();
    renderWithProvider(defaultProps({ onOpenSettings }));
    await openHamburger();
    fireEvent.click(screen.getByText("설정"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleCurrentSessionStar when star menu item clicked", async () => {
    const onToggleCurrentSessionStar = vi.fn();
    renderWithProvider(defaultProps({ onToggleCurrentSessionStar }));
    await openHamburger();
    fireEvent.click(screen.getByText("현재 세션 즐겨찾기"));
    expect(onToggleCurrentSessionStar).toHaveBeenCalledTimes(1);
  });

  it("keeps hamburger enabled while streaming", () => {
    renderWithProvider(defaultProps({ streaming: true }));
    expect(screen.getByTitle("더 많은 메뉴")).not.toBeDisabled();
  });

  it("does not load the current session from history", async () => {
    const onLoadSession = vi.fn();
    renderWithProvider(defaultProps({
      currentSessionId: "sess-1",
      sessions: [
        { id: "sess-1", modifiedAt: new Date().toISOString(), title: "현재 세션" },
      ],
      onLoadSession,
    }));

    await openHamburger();

    await waitFor(() => expect(screen.queryByText("현재 세션")).toBeTruthy());
    fireEvent.click(screen.getByText("현재 세션"));
    expect(onLoadSession).not.toHaveBeenCalled();
  });

  // SEV-2-A regression: 내보내기 trigger must be a DropdownMenuSubTrigger (not a nested DropdownMenu).
  it("내보내기 is rendered as a DropdownMenuSubTrigger with correct data attributes", async () => {
    renderWithProvider(defaultProps());
    await openHamburger();

    // DropdownMenuSubTrigger renders with data-radix-collection-item (it's a menu item)
    // and has [data-state] managed by Radix Sub. Verify it exists and is the right element type.
    const subTrigger = screen.getByText("내보내기").closest("[data-radix-collection-item]");
    expect(subTrigger).toBeTruthy();
    // It must NOT be a DropdownMenu root (no aria-expanded on the trigger — Sub handles it differently)
    // The key correctness signal: the element role is "menuitem" not "button"
    expect(subTrigger?.getAttribute("role")).toBe("menuitem");
  });

  it("starring a history session does not also load it", async () => {
    const onLoadSession = vi.fn();
    const onToggleSessionStar = vi.fn();
    renderWithProvider(defaultProps({
      currentSessionId: "sess-current",
      sessions: [
        { id: "sess-other", modifiedAt: new Date().toISOString(), title: "다른 세션" },
      ],
      onLoadSession,
      onToggleSessionStar,
    }));

    await openHamburger();

    await waitFor(() => expect(screen.getByText("다른 세션")).toBeTruthy());
    fireEvent.click(screen.getByTitle("세션 즐겨찾기"));

    expect(onToggleSessionStar).toHaveBeenCalledWith("sess-other", "다른 세션");
    expect(onLoadSession).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
