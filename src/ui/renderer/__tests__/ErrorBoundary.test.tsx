/**
 * ErrorBoundary renderer test.
 *
 * Verifies:
 * 1. Throwing child renders fallback message.
 * 2. Reload button is present in error state.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary.js";

function ThrowingChild(): never {
  throw new Error("test render error");
}

/** Helper that toggles its own throw — lets tests verify reset works. */
function ConditionallyThrowing({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("toggle throw");
  return <div data-testid="recovered-child">recovered</div>;
}

describe("ErrorBoundary", () => {
  it("shows fallback message when child throws", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      <ErrorBoundary fallback="앱 오류가 발생했습니다">
        <ThrowingChild />
      </ErrorBoundary>,
    );
    expect(getByText("앱 오류가 발생했습니다")).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("shows reload button in error state", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );
    expect(getByText("새로고침")).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("logs boundaryName in console.error so multi-boundary apps can distinguish failures (#736)", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary boundaryName="main-content">
        <ThrowingChild />
      </ErrorBoundary>,
    );
    const calls = consoleSpy.mock.calls.map((args) => String(args[0]));
    expect(calls.some((s) => s.includes("boundary='main-content'"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("renders 'Try again' button only when onReset prop is provided", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onReset = vi.fn();
    const { getByText, queryByText, rerender } = render(
      <ErrorBoundary onReset={onReset}>
        <ThrowingChild />
      </ErrorBoundary>,
    );
    expect(getByText("다시 시도")).toBeDefined();
    // Without onReset → no retry button
    rerender(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );
    expect(queryByText("다시 시도")).toBeNull();
    consoleSpy.mockRestore();
  });

  it("'다시 시도' click invokes onReset AND clears error state — recovers without page reload (#736)", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Harness() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <ErrorBoundary
          onReset={() => {
            setShouldThrow(false);
          }}
        >
          <ConditionallyThrowing shouldThrow={shouldThrow} />
        </ErrorBoundary>
      );
    }
    const { getByText, queryByTestId } = render(<Harness />);
    // Initial: error state, child not rendered
    expect(getByText("다시 시도")).toBeDefined();
    expect(queryByTestId("recovered-child")).toBeNull();
    // Click retry → onReset fires (toggles shouldThrow=false) + boundary state clears
    fireEvent.click(getByText("다시 시도"));
    // Child re-renders successfully
    expect(queryByTestId("recovered-child")).not.toBeNull();
    consoleSpy.mockRestore();
  });

  it("compact mode renders inline (single-line) fallback", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      <ErrorBoundary compact fallback="이 영역 오류">
        <ThrowingChild />
      </ErrorBoundary>,
    );
    const fallbackEl = getByText("이 영역 오류");
    // Compact mode wraps in a horizontal flex container
    expect(fallbackEl.closest("div")?.className).toContain("flex");
    expect(fallbackEl.closest("div")?.className).toContain("items-center");
    consoleSpy.mockRestore();
  });
});
