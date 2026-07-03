// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerticalSplitLayout } from "../VerticalSplitLayout.js";

afterEach(cleanup);

function renderLayout(topPercent = 45) {
  const onDragChange = vi.fn();
  const onCommit = vi.fn();
  render(
    <VerticalSplitLayout
      topPercent={topPercent}
      onDragChange={onDragChange}
      onCommit={onCommit}
      ariaLabel="Resize"
      testId="split"
      separatorTestId="splitter"
      top={<div data-testid="top-pane">top</div>}
      bottom={<div data-testid="bottom-pane">bottom</div>}
    />,
  );
  return { onDragChange, onCommit };
}

describe("VerticalSplitLayout", () => {
  it("applies the top-percent to the grid template rows", () => {
    renderLayout(45);
    const layout = screen.getByTestId("split");
    expect(layout.style.gridTemplateRows).toContain("45%");
    expect(screen.getByTestId("top-pane")).toBeTruthy();
    expect(screen.getByTestId("bottom-pane")).toBeTruthy();
  });

  it("gives the separator a ≥20px hit zone (1.25rem row) while the visual line stays thin", () => {
    renderLayout(45);
    // The middle grid track is the pointer hit zone: 1.25rem == 20px, above the
    // ~20-24px floor for a reliable drag (R1). The visible line inside is 2px.
    const layout = screen.getByTestId("split");
    expect(layout.style.gridTemplateRows).toContain("1.25rem");
    const line = screen.getByTestId("splitter").querySelector("span");
    expect(line?.className).toContain("h-0.5");
  });

  it("ArrowDown nudges the split down and commits (keyboard step)", () => {
    const { onDragChange, onCommit } = renderLayout(45);
    fireEvent.keyDown(screen.getByTestId("splitter"), { key: "ArrowDown" });
    expect(onDragChange).toHaveBeenCalledWith(50);
    expect(onCommit).toHaveBeenCalledWith(50);
  });

  it("ArrowUp nudges the split up and commits", () => {
    const { onDragChange, onCommit } = renderLayout(45);
    fireEvent.keyDown(screen.getByTestId("splitter"), { key: "ArrowUp" });
    expect(onDragChange).toHaveBeenCalledWith(40);
    expect(onCommit).toHaveBeenCalledWith(40);
  });

  it("Home / End jump to the pane range bounds", () => {
    const { onCommit } = renderLayout(45);
    fireEvent.keyDown(screen.getByTestId("splitter"), { key: "Home" });
    expect(onCommit).toHaveBeenCalledWith(22);
    fireEvent.keyDown(screen.getByTestId("splitter"), { key: "End" });
    expect(onCommit).toHaveBeenCalledWith(78);
  });

  it("keyboard step clamps at the max (no overshoot past 78)", () => {
    const { onDragChange } = renderLayout(76);
    fireEvent.keyDown(screen.getByTestId("splitter"), { key: "ArrowDown" });
    expect(onDragChange).toHaveBeenCalledWith(78);
  });

  it("a zero-height layout guards the drag against NaN (no callback)", () => {
    const { onDragChange } = renderLayout(45);
    const splitter = screen.getByTestId("splitter");
    // jsdom getBoundingClientRect returns all-zero, so rect.height <= 0 → the
    // drag start must early-return without emitting a NaN percent.
    fireEvent.pointerDown(splitter, { clientY: 100 });
    expect(onDragChange).not.toHaveBeenCalled();
  });
});
