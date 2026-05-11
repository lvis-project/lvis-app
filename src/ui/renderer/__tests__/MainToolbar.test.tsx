import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { MainToolbar } from "../MainToolbar.js";

function defaultProps(overrides: Partial<Parameters<typeof MainToolbar>[0]> = {}) {
  return {
    activeView: "home",
    streaming: false,
    hasApiKey: true as boolean | null,
    isCurrentSessionStarred: false,
    onNewChat: vi.fn(),
    onToggleCurrentSessionStar: vi.fn(),
    onExport: vi.fn(),
    onOpenHome: vi.fn(),
    onOpenRoutinesView: vi.fn(),
    onOpenMemoryView: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenUnifiedSearch: vi.fn(),
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
  it("renders hamburger trigger and keeps 새 대화 inside the menu", async () => {
    renderWithProvider(defaultProps());
    expect(screen.getByTitle("홈")).toBeTruthy();
    expect(screen.getByTitle("더 많은 메뉴")).toBeTruthy();
    expect(screen.queryByText("새 대화")).toBeNull();
    await openHamburger();
    expect(screen.getByText("새 대화")).toBeTruthy();
    // TokenProgressRing is now in InputActionBar, not MainToolbar
    expect(document.querySelector("[data-testid='token-progress-ring']")).toBeNull();
  });

  it("calls onNewChat when 새 대화 menu item clicked", async () => {
    const onNewChat = vi.fn();
    renderWithProvider(defaultProps({ onNewChat }));
    await openHamburger();
    fireEvent.click(screen.getByText("새 대화"));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenHome when the home action is clicked", () => {
    const onOpenHome = vi.fn();
    renderWithProvider(defaultProps({ onOpenHome, activeView: "memory" }));
    fireEvent.click(screen.getByTitle("홈"));
    expect(onOpenHome).toHaveBeenCalledTimes(1);
  });

  it("calls built-in view handlers from the hamburger menu", async () => {
    const onOpenRoutinesView = vi.fn();
    const onOpenMemoryView = vi.fn();
    renderWithProvider(defaultProps({ onOpenRoutinesView, onOpenMemoryView }));

    await openHamburger();
    fireEvent.click(screen.getByText("루틴"));
    await openHamburger();
    fireEvent.click(screen.getByText("메모리"));

    expect(onOpenRoutinesView).toHaveBeenCalledTimes(1);
    expect(onOpenMemoryView).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenUnifiedSearch when unified search button clicked", () => {
    const onOpenUnifiedSearch = vi.fn();
    renderWithProvider(defaultProps({ onOpenUnifiedSearch }));
    fireEvent.click(screen.getByTitle("통합 검색 (Cmd/Ctrl+F)"));
    expect(onOpenUnifiedSearch).toHaveBeenCalledTimes(1);
  });

  it("hamburger does not contain a duplicate search item", async () => {
    renderWithProvider(defaultProps());
    await openHamburger();
    expect(screen.queryByText("통합 검색")).toBeNull();
  });

  it("calls onOpenStarredView when 즐겨찾기 menu item clicked", async () => {
    const onOpenStarredView = vi.fn();
    renderWithProvider(defaultProps({ onOpenStarredView }));
    await openHamburger();
    fireEvent.click(screen.getByText("즐겨찾기"));
    expect(onOpenStarredView).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenSettings when 설정 menu item clicked", async () => {
    const onOpenSettings = vi.fn();
    renderWithProvider(defaultProps({ onOpenSettings }));
    await openHamburger();
    fireEvent.click(screen.getByText("설정"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleCurrentSessionStar when top star action clicked", () => {
    const onToggleCurrentSessionStar = vi.fn();
    renderWithProvider(defaultProps({ onToggleCurrentSessionStar }));
    fireEvent.click(screen.getByTitle("현재 세션 즐겨찾기"));
    expect(onToggleCurrentSessionStar).toHaveBeenCalledTimes(1);
  });

  it("keeps hamburger enabled while streaming", () => {
    renderWithProvider(defaultProps({ streaming: true }));
    expect(screen.getByTitle("더 많은 메뉴")).not.toBeDisabled();
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});
