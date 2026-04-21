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
  it("renders null with no plugin views", () => {
    const { container } = render(
      <Sidebar pluginViews={[]} setActiveView={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders plugin view label", () => {
    const { getByText } = render(
      <Sidebar pluginViews={[makeView("Meeting Recorder")]} setActiveView={vi.fn()} />,
    );
    expect(getByText("Meeting Recorder")).toBeTruthy();
  });

  it("calls setActiveView when button is clicked", () => {
    const view = makeView();
    const setActiveView = vi.fn();
    const { getByText } = render(
      <Sidebar pluginViews={[view]} setActiveView={setActiveView} />,
    );
    fireEvent.click(getByText("Test Plugin"));
    expect(setActiveView).toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
