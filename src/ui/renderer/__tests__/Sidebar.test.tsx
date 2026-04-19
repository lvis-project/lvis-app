/**
 * Sidebar unit tests.
 *
 * Sidebar is a pure-props component — render directly via RTL without App.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Sidebar } from "../Sidebar.js";
import type { MarketplaceItem } from "../types.js";

function makePlugin(overrides: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: "com.test.plugin",
    name: "Test Plugin",
    description: "A test plugin",
    packageSpec: "test-plugin@1.0.0",
    installed: false,
    enabled: true,
    ...overrides,
  };
}

describe("Sidebar", () => {
  it("renders without crashing with empty marketplace", () => {
    const { container } = render(
      <Sidebar
        marketStatus="로드됨"
        marketplace={[]}
        pluginViews={[]}
        working={false}
        setInstallTarget={vi.fn()}
        setUninstallTarget={vi.fn()}
        setActiveView={vi.fn()}
      />,
    );
    expect(container).toBeTruthy();
  });

  it("renders plugin name from marketplace list", () => {
    const { getByText } = render(
      <Sidebar
        marketStatus="로드됨"
        marketplace={[makePlugin({ name: "Meeting Recorder" })]}
        pluginViews={[]}
        working={false}
        setInstallTarget={vi.fn()}
        setUninstallTarget={vi.fn()}
        setActiveView={vi.fn()}
      />,
    );
    expect(getByText("Meeting Recorder")).toBeTruthy();
  });

  it("calls setInstallTarget when install button is clicked", () => {
    const plugin = makePlugin({ installed: false });
    const setInstallTarget = vi.fn();
    const { getByText } = render(
      <Sidebar
        marketStatus="로드됨"
        marketplace={[plugin]}
        pluginViews={[]}
        working={false}
        setInstallTarget={setInstallTarget}
        setUninstallTarget={vi.fn()}
        setActiveView={vi.fn()}
      />,
    );
    fireEvent.click(getByText("설치"));
    expect(setInstallTarget).toHaveBeenCalledWith(plugin);
  });

  it("shows 설치됨 badge for installed plugin", () => {
    const { getByText } = render(
      <Sidebar
        marketStatus="로드됨"
        marketplace={[makePlugin({ installed: true })]}
        pluginViews={[]}
        working={false}
        setInstallTarget={vi.fn()}
        setUninstallTarget={vi.fn()}
        setActiveView={vi.fn()}
      />,
    );
    expect(getByText("설치됨")).toBeTruthy();
  });

  it("install button disabled when working=true", () => {
    const { container } = render(
      <Sidebar
        marketStatus="로드됨"
        marketplace={[makePlugin()]}
        pluginViews={[]}
        working={true}
        setInstallTarget={vi.fn()}
        setUninstallTarget={vi.fn()}
        setActiveView={vi.fn()}
      />,
    );
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
