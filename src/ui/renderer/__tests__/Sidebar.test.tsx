/**
 * Sidebar unit tests.
 *
 * Sidebar is a pure-props component — render directly via RTL without App.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Sidebar } from "../Sidebar.js";
import type { PluginUiExtension } from "../types.js";

function makeView(label = "Test Plugin", pluginId = "com.test.plugin"): PluginUiExtension {
  return {
    pluginId,
    extension: {
      id: "test-ext",
      slot: "sidebar",
      kind: "info-card",
      title: label,
    },
  };
}

describe("Sidebar", () => {
  it("renders built-in navigation even with no plugin views", () => {
    const { getByText } = render(
      <Sidebar activeView="home" pluginViews={[]} setActiveView={vi.fn()} starredCount={0} />,
    );
    expect(getByText("홈")).toBeTruthy();
    expect(getByText("태스크")).toBeTruthy();
    expect(getByText("즐겨찾기")).toBeTruthy();
    expect(getByText("메모리")).toBeTruthy();
  });

  it("renders plugin view label", () => {
    const { getByText } = render(
      <Sidebar activeView="home" pluginViews={[makeView("Meeting Recorder")]} setActiveView={vi.fn()} starredCount={0} />,
    );
    expect(getByText("Meeting Recorder")).toBeTruthy();
  });

  it("calls setActiveView when button is clicked", () => {
    const view = makeView();
    const setActiveView = vi.fn();
    const { getByText } = render(
      <Sidebar activeView="home" pluginViews={[view]} setActiveView={setActiveView} starredCount={0} />,
    );
    fireEvent.click(getByText("Test Plugin"));
    expect(setActiveView).toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
