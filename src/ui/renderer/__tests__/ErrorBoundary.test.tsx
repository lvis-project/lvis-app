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

  it("onReset receives the captured Error so callers can branch on error class", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onReset = vi.fn();
    const { getByText } = render(
      <ErrorBoundary onReset={onReset}>
        <ThrowingChild />
      </ErrorBoundary>,
    );
    fireEvent.click(getByText("다시 시도"));
    // Caller's onReset received the Error object captured by getDerivedStateFromError
    expect(onReset).toHaveBeenCalledTimes(1);
    const passedArg = onReset.mock.calls[0][0];
    expect(passedArg).toBeInstanceOf(Error);
    expect(passedArg.message).toBe("test render error");
    consoleSpy.mockRestore();
  });

  it("onReset throwing does NOT trap the boundary in error state — state still clears", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Harness() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <ErrorBoundary
          onReset={() => {
            // Trigger BOTH a throw AND a state change. The boundary must
            // catch the throw, log it, and still proceed to clear its
            // own error state so the children get a chance to re-render.
            setShouldThrow(false);
            throw new Error("onReset hook intentionally throws");
          }}
        >
          <ConditionallyThrowing shouldThrow={shouldThrow} />
        </ErrorBoundary>
      );
    }
    const { getByText, queryByTestId } = render(<Harness />);
    expect(queryByTestId("recovered-child")).toBeNull();
    fireEvent.click(getByText("다시 시도"));
    // Boundary cleared its state despite onReset throwing → children re-rendered
    expect(queryByTestId("recovered-child")).not.toBeNull();
    // Verify the onReset throw was logged (forensic trail for the caller bug)
    const calls = consoleSpy.mock.calls.map((args) => String(args[0]));
    expect(calls.some((s) => s.includes("onReset hook threw"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("(integration) inner boundary failure does NOT bubble to outer sibling — sibling stays mounted (#736)", () => {
    // Mimics the App.tsx layout: outer boundary wraps the whole tree;
    // inner boundary scopes a sub-region. Sibling region (Toolbar stub)
    // sits OUTSIDE the inner boundary. When the inner sub-region throws,
    // the inner boundary catches it; the sibling stays in the DOM.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByTestId, getByText } = render(
      <ErrorBoundary boundaryName="outer-root">
        <div data-testid="sibling-toolbar">toolbar stays mounted</div>
        <ErrorBoundary boundaryName="inner-main-content" fallback="메인 영역 오류">
          <ThrowingChild />
        </ErrorBoundary>
      </ErrorBoundary>,
    );
    // Inner boundary caught the throw and shows its scoped fallback
    expect(getByText("메인 영역 오류")).toBeDefined();
    // Sibling (mocking MainToolbar / Settings access) is still rendered
    expect(getByTestId("sibling-toolbar")).toBeDefined();
    // Outer boundary's fallback is NOT shown (the throw didn't propagate)
    const calls = consoleSpy.mock.calls.map((args) => String(args[0]));
    expect(calls.some((s) => s.includes("boundary='inner-main-content'"))).toBe(true);
    expect(calls.some((s) => s.includes("boundary='outer-root'"))).toBe(false);
    consoleSpy.mockRestore();
  });
});
