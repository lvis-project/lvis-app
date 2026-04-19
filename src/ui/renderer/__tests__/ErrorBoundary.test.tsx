/**
 * ErrorBoundary renderer test.
 *
 * Verifies:
 * 1. Throwing child renders fallback message.
 * 2. Reload button is present in error state.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ErrorBoundary } from "../components/ErrorBoundary.js";

function ThrowingChild(): never {
  throw new Error("test render error");
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
});
