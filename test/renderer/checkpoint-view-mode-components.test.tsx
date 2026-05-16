/**
 * Checkpoint view-mode — component unit tests.
 *
 * Covers:
 *  1. ViewModeBanner: hidden when viewMode=null, shown when non-null, exit button fires onExit
 *  2. CheckpointDivider: action buttons visible/hidden based on compactNum + callbacks
 */
import "./setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ViewModeBanner } from "../../src/ui/renderer/components/ViewModeBanner.js";
import { CheckpointDivider } from "../../src/ui/renderer/components/CheckpointDivider.js";

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
