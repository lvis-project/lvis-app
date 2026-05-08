/**
 * §PR-5 Layer 3 View-Mode — component unit tests.
 *
 * Covers:
 *  1. ViewModeBanner: hidden when viewMode=null, shown when non-null, exit button fires onExit
 *  2. CheckpointDivider: action buttons visible/hidden based on compactNum + callbacks
 *  3. Sidebar: branch sessions rendered with indentation + badge when parentSessionId present
 */
import "./setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ViewModeBanner } from "../../src/ui/renderer/components/ViewModeBanner.js";
import { CheckpointDivider } from "../../src/ui/renderer/components/CheckpointDivider.js";
import { Sidebar } from "../../src/ui/renderer/Sidebar.js";

/* ────────────────────────────────────────────────────────────────────────
 * ViewModeBanner
 * ──────────────────────────────────────────────────────────────────────── */
describe("ViewModeBanner", () => {
  it("renders nothing when viewMode is null", () => {
    const { container } = render(<ViewModeBanner viewMode={null} onExit={vi.fn()} />);
    expect(container.querySelector("[data-testid='view-mode-banner']")).toBeNull();
  });

  it("renders banner when viewMode is provided", () => {
    const { getByTestId } = render(
      <ViewModeBanner viewMode={{ compactNum: 3, slicedRangeEnd: 12 }} onExit={vi.fn()} />,
    );
    expect(getByTestId("view-mode-banner")).toBeTruthy();
    expect(getByTestId("view-mode-banner-title").textContent).toContain("#3");
  });

  it("calls onExit when exit button is clicked", () => {
    const onExit = vi.fn();
    const { getByTestId } = render(
      <ViewModeBanner viewMode={{ compactNum: 1, slicedRangeEnd: 5 }} onExit={onExit} />,
    );
    fireEvent.click(getByTestId("view-mode-exit-btn"));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * CheckpointDivider
 * ──────────────────────────────────────────────────────────────────────── */
describe("CheckpointDivider", () => {
  it("renders without action buttons when compactNum is absent", () => {
    const { container } = render(
      <CheckpointDivider messageCount={10} />,
    );
    expect(container.querySelector("[data-testid='checkpoint-actions']")).toBeNull();
  });

  it("renders without action buttons when compactNum provided but no callbacks", () => {
    const { container } = render(
      <CheckpointDivider messageCount={10} compactNum={2} />,
    );
    expect(container.querySelector("[data-testid='checkpoint-actions']")).toBeNull();
  });

  it("renders both action buttons when compactNum + both callbacks provided", () => {
    const { getByTestId } = render(
      <CheckpointDivider
        messageCount={10}
        compactNum={2}
        onEnterView={vi.fn()}
        onBranchFrom={vi.fn()}
      />,
    );
    expect(getByTestId("ck-btn-view")).toBeTruthy();
    expect(getByTestId("ck-btn-fork")).toBeTruthy();
  });

  it("calls onEnterView with compactNum when view button clicked", () => {
    const onEnterView = vi.fn();
    const { getByTestId } = render(
      <CheckpointDivider
        messageCount={5}
        compactNum={4}
        onEnterView={onEnterView}
        onBranchFrom={vi.fn()}
      />,
    );
    fireEvent.click(getByTestId("ck-btn-view"));
    expect(onEnterView).toHaveBeenCalledWith(4);
  });

  it("calls onBranchFrom with compactNum when fork button clicked", () => {
    const onBranchFrom = vi.fn();
    const { getByTestId } = render(
      <CheckpointDivider
        messageCount={5}
        compactNum={4}
        onEnterView={vi.fn()}
        onBranchFrom={onBranchFrom}
      />,
    );
    fireEvent.click(getByTestId("ck-btn-fork"));
    expect(onBranchFrom).toHaveBeenCalledWith(4);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Sidebar branch tree
 * ──────────────────────────────────────────────────────────────────────── */
describe("Sidebar branch tree", () => {
  // Both fork sessions must have branchedFromCompactNum — that's the discriminator
  // for true checkpoint forks (parentSessionId alone is also used for resume/rotation).
  const baseSessions = [
    { id: "sess-parent", modifiedAt: "2026-05-08T10:00:00Z", title: "부모 세션" },
    { id: "sess-child-1", modifiedAt: "2026-05-08T11:00:00Z", title: "분기 세션 A", parentSessionId: "sess-parent", branchedFromCompactNum: 2 },
    { id: "sess-child-2", modifiedAt: "2026-05-08T12:00:00Z", title: "분기 세션 B", parentSessionId: "sess-parent", branchedFromCompactNum: 3 },
  ];

  it("does not render branch panel when no sessions have branchedFromCompactNum", () => {
    // parentSessionId without branchedFromCompactNum = resume/rotation, not a fork
    const resumeSessions = [
      { id: "s1", modifiedAt: "2026-05-08T10:00:00Z", title: "일반 세션" },
      { id: "s2", modifiedAt: "2026-05-08T11:00:00Z", title: "재개 세션", parentSessionId: "s1" },
    ];
    const { container } = render(
      <Sidebar
        activeView="home"
        setActiveView={vi.fn()}
        starredCount={0}
        sessions={resumeSessions}
        onLoadSession={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-testid='branch-session-s2']")).toBeNull();
  });

  it("renders branch sessions with branch badge when branchedFromCompactNum present", () => {
    const { getByTestId } = render(
      <Sidebar
        activeView="home"
        setActiveView={vi.fn()}
        starredCount={0}
        sessions={baseSessions}
        onLoadSession={vi.fn()}
      />,
    );
    expect(getByTestId("branch-session-sess-child-1")).toBeTruthy();
    expect(getByTestId("branch-session-sess-child-2")).toBeTruthy();
    // branch badge text
    const item = getByTestId("branch-session-sess-child-1");
    expect(item.textContent).toContain("branch");
  });

  it("calls onLoadSession with the branch session id when clicked", () => {
    const onLoadSession = vi.fn();
    const { getByTestId } = render(
      <Sidebar
        activeView="home"
        setActiveView={vi.fn()}
        starredCount={0}
        sessions={baseSessions}
        onLoadSession={onLoadSession}
      />,
    );
    fireEvent.click(getByTestId("branch-session-sess-child-1"));
    expect(onLoadSession).toHaveBeenCalledWith("sess-child-1");
  });
});
