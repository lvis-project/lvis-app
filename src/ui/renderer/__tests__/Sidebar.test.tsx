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

  it("does NOT render plugin view labels (plugins moved to InputActionBar grid)", () => {
    const { queryByText } = render(
      <Sidebar activeView="home" pluginViews={[makeView("Meeting Recorder")]} setActiveView={vi.fn()} starredCount={0} />,
    );
    // Plugin entries no longer appear in the sidebar — they are shown via
    // the PluginGridButton in InputActionBar.
    expect(queryByText("Meeting Recorder")).toBeNull();
  });

  it("does not call setActiveView for plugin views (plugins only accessible via InputActionBar)", () => {
    const view = makeView();
    const setActiveView = vi.fn();
    const { queryByText } = render(
      <Sidebar activeView="home" pluginViews={[view]} setActiveView={setActiveView} starredCount={0} />,
    );
    // "Test Plugin" button should not exist in sidebar
    expect(queryByText("Test Plugin")).toBeNull();
    expect(setActiveView).not.toHaveBeenCalled();
  });

  it("shows the starred badge count", () => {
    const { getByText } = render(
      <Sidebar activeView="home" pluginViews={[]} setActiveView={vi.fn()} starredCount={3} />,
    );
    expect(getByText("(3)")).toBeTruthy();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
