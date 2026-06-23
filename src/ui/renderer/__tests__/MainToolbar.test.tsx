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
    onToggleCurrentSessionStar: vi.fn(),
    onExport: vi.fn(),
    onOpenUnifiedSearch: vi.fn(),
    sidebarCollapsed: false,
    appMode: "action" as const,
    onToggleAppMode: vi.fn(),
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

/** Open the standalone export dropdown (Radix trigger fires on pointerDown). */
async function openExport() {
  const exportBtn = screen.getByTestId("toolbar-export");
  fireEvent.pointerDown(exportBtn);
  await waitFor(() => expect(screen.queryByTestId("toolbar-export-markdown")).toBeTruthy());
}

describe("MainToolbar", () => {
  // The toolbar content now lives in the window-control band. The hamburger
  // menu is gone entirely: nav lives in the Sidebar, Settings moved to the
  // Sidebar, and Export is a standalone band button after the star.
  it("no longer renders a hamburger / more-menu trigger", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTitle("더 많은 메뉴")).toBeNull();
    // Home + 새 대화 nav owned by the Sidebar — never in the toolbar.
    expect(screen.queryByTitle("홈")).toBeNull();
    expect(screen.queryByText("새 대화")).toBeNull();
    expect(document.querySelector("[data-testid='token-progress-ring']")).toBeNull();
  });

  it("does not render a Home button (Home nav is owned by the Sidebar)", () => {
    renderWithProvider(defaultProps({ activeView: "memory" }));
    expect(screen.queryByTitle("홈")).toBeNull();
  });

  it("calls onOpenUnifiedSearch when unified search button clicked", () => {
    const onOpenUnifiedSearch = vi.fn();
    renderWithProvider(defaultProps({ onOpenUnifiedSearch }));
    fireEvent.click(screen.getByTitle("통합 검색 (Cmd/Ctrl+F)"));
    expect(onOpenUnifiedSearch).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleCurrentSessionStar when top star action clicked", () => {
    const onToggleCurrentSessionStar = vi.fn();
    renderWithProvider(defaultProps({ onToggleCurrentSessionStar }));
    fireEvent.click(screen.getByTitle("현재 세션 즐겨찾기"));
    expect(onToggleCurrentSessionStar).toHaveBeenCalledTimes(1);
  });

  // The collapse toggle moved OUT of the band onto the floating sidebar card's
  // right edge (see Sidebar.tsx / Sidebar tests). The band no longer hosts it.
  it("no longer renders the sidebar collapse toggle (it lives on the sidebar card)", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTestId("sidebar-collapse-toggle")).toBeNull();
  });

  // The leading cluster (search/star/export) is left-padded so it begins to the
  // right of the floating sidebar edge; the offset tracks sidebarCollapsed.
  it("offsets the band content past the sidebar (expanded vs collapsed)", () => {
    const expanded = renderWithProvider(defaultProps({ sidebarCollapsed: false }));
    expect(screen.getByTestId("main-toolbar").className).toContain("pl-[15.5rem]");
    expanded.unmount();
    renderWithProvider(defaultProps({ sidebarCollapsed: true }));
    expect(screen.getByTestId("main-toolbar").className).toContain("pl-[5rem]");
  });

  // Export is a standalone band button (검색 → 별 → 내보내기). Clicking opens
  // a small format menu; selecting a format calls the export handler — the
  // same handler the removed hamburger submenu used.
  it("exports markdown from the standalone export button", async () => {
    const onExport = vi.fn();
    renderWithProvider(defaultProps({ onExport }));
    await openExport();
    fireEvent.click(screen.getByTestId("toolbar-export-markdown"));
    expect(onExport).toHaveBeenCalledWith("markdown");
  });

  it("exports json from the standalone export button", async () => {
    const onExport = vi.fn();
    renderWithProvider(defaultProps({ onExport }));
    await openExport();
    fireEvent.click(screen.getByTestId("toolbar-export-json"));
    expect(onExport).toHaveBeenCalledWith("json");
  });

  it("exposes semantic state for compact icon actions", () => {
    renderWithProvider(defaultProps({ isCurrentSessionStarred: true }));
    expect(screen.getByTitle("내보내기")).toHaveAttribute("aria-label", "내보내기");
    expect(screen.getByTitle("현재 세션 즐겨찾기 해제")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the export button enabled while streaming", () => {
    renderWithProvider(defaultProps({ streaming: true }));
    expect(screen.getByTestId("toolbar-export")).not.toBeDisabled();
  });

  // data-tour-anchor attributes must remain for the SpotlightTour onboarding
  // chain. "settings-entry" relocated to the export button now that the
  // hamburger (its previous host) is gone.
  it("preserves tour anchors on toolbar controls", () => {
    renderWithProvider(defaultProps());
    expect(document.querySelector("[data-tour-anchor='chat-history']")).toBeTruthy();
    expect(document.querySelector("[data-tour-anchor='settings-entry']")).toBeTruthy();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
