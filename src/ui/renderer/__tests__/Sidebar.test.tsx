/**
 * Sidebar unit tests.
 *
 * Sidebar is a pure-props component — render directly via RTL without App.
 * Sidebar's responsibility is built-in nav only; plugin views are surfaced
 * through the InputActionBar plugin grid (covered by PluginGridButton tests).
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { Sidebar } from "../Sidebar.js";

describe("Sidebar", () => {
  it("renders built-in navigation", () => {
    const { getByText } = render(
      <Sidebar activeView="home" setActiveView={vi.fn()} starredCount={0} />,
    );
    expect(getByText("홈")).toBeTruthy();
    expect(getByText("즐겨찾기")).toBeTruthy();
    expect(getByText("메모리")).toBeTruthy();
  });

  it("shows the starred badge count", () => {
    const { getByText } = render(
      <Sidebar activeView="home" setActiveView={vi.fn()} starredCount={3} />,
    );
    expect(getByText("(3)")).toBeTruthy();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
