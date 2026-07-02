import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { MainToolbar } from "../MainToolbar.js";

function defaultProps(overrides: Partial<Parameters<typeof MainToolbar>[0]> = {}) {
  return {
    activeView: "home",
    streaming: false,
    hasApiKey: true as boolean | null,
    appMode: "work" as const,
    onToggleAppMode: vi.fn(),
    sidePanelOpen: false,
    onToggleSidePanel: vi.fn(),
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

  it("does not render a Home button (Home nav is owned by the Sidebar)", () => {
    renderWithProvider(defaultProps({ activeView: "memory" }));
    expect(screen.queryByTitle("홈")).toBeNull();
  });

  // The search / star / export controls + the collapse toggle moved to the
  // sidebar cluster strip — the band must NOT host them anymore.
  it("no longer renders the search / star / export controls (they live in the sidebar cluster)", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTitle("통합 검색 (Cmd/Ctrl+F)")).toBeNull();
    expect(screen.queryByTitle("현재 세션 즐겨찾기")).toBeNull();
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

  it("renders an icon-only side-panel toggle to the right of the mode toggle", () => {
    const onToggleSidePanel = vi.fn();
    const { container } = renderWithProvider(defaultProps({ onToggleSidePanel }));

    const modeToggle = screen.getByTestId("app-mode-toggle");
    const sidePanelToggle = screen.getByTestId("chat-side-panel-toggle");
    expect(sidePanelToggle.textContent?.trim()).toBe("");
    expect(sidePanelToggle.compareDocumentPosition(modeToggle) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    fireEvent.click(sidePanelToggle);
    expect(onToggleSidePanel).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-testid='chat-side-panel-toggle'] svg")).toBeTruthy();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
