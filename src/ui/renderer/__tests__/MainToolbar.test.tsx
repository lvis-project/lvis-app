import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { MainToolbar } from "../MainToolbar.js";
import { TEST_IDS } from "../../../shared/test-ids.js";

function defaultProps(overrides: Partial<Parameters<typeof MainToolbar>[0]> = {}) {
  return {
    streaming: false,
    hasApiKey: true as boolean | null,
    appMode: "work" as const,
    onToggleAppMode: vi.fn(),
    viewNav: {
      segments: [{ key: "home", label: "홈" }],
      canGoBack: false,
      canGoForward: false,
      onBack: vi.fn(),
      onForward: vi.fn(),
      onSelectSegment: vi.fn(),
    },
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
  // The band now hosts ONLY the right-aligned controls (app-update badge, Dev
  // badge, Chat/Work mode toggle). The search / star / export controls + the
  // collapse toggle moved into the floating sidebar's cluster strip next to the
  // traffic lights (see Sidebar.tsx / Sidebar tests).
  it("no longer renders a hamburger / more-menu trigger", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTitle("더 많은 메뉴")).toBeNull();
    expect(screen.queryByTitle("홈")).toBeNull();
    expect(screen.queryByText("새 대화")).toBeNull();
    expect(document.querySelector("[data-testid='token-progress-ring']")).toBeNull();
  });

  it("names the location on its leading edge, where the sidebar card ends", () => {
    // History (back/forward) moved to the sidebar, which owns routes. The PATH
    // stays on the band: it says WHERE THE WINDOW IS, and giving it a row of
    // its own below the band cost 28px of every screen to repeat that.
    renderWithProvider(defaultProps());
    const crumb = document.querySelector("[data-testid='view-path-breadcrumb']");
    expect(crumb).toBeTruthy();
    expect(crumb!.textContent).toContain("홈");
    // It is a path, not a Home button — no history controls come with it.
    expect(screen.queryByTestId(TEST_IDS.viewPathBack)).toBeNull();
  });

  // The search / star / export controls + the collapse toggle moved to the
  // sidebar cluster strip — the band must NOT host them anymore.
  it("no longer renders the search / star / export controls (they live in the sidebar cluster)", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTitle("통합 검색 (Cmd/Ctrl+F)")).toBeNull();
    expect(screen.queryByTitle("현재 세션 핀 고정")).toBeNull();
    expect(screen.queryByTestId("toolbar-export")).toBeNull();
  });

  it("no longer renders the sidebar collapse toggle (it lives in the sidebar cluster)", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTestId("sidebar-collapse-toggle")).toBeNull();
  });

  // The Chat/Work mode toggle stays on the band, wired to appMode.
  it("renders the Chat/Work mode toggle and fires onToggleAppMode", () => {
    const onToggleAppMode = vi.fn();
    renderWithProvider(defaultProps({ appMode: "work", onToggleAppMode }));
    expect(screen.getByTestId("app-mode-toggle")).toBeTruthy();
    expect(screen.getByText("업무")).toBeTruthy();
    expect(screen.queryByText("액션")).toBeNull();
    fireEvent.click(screen.getByTestId("app-mode-chat"));
    expect(onToggleAppMode).toHaveBeenCalledWith("chat");
  });

  it("no longer renders the work-panel toggle (each chat group owns its panel)", () => {
    // One window-level button cannot mean the right thing once more than one
    // conversation is on screen, so the control moved into the group header.
    renderWithProvider(defaultProps());
    expect(screen.queryByTestId("chat-side-panel-toggle")).toBeNull();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
