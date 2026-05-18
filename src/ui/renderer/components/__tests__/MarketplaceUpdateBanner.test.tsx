// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarketplaceUpdateBanner } from "../MarketplaceUpdateBanner.js";
import type { PluginUpdateInfo } from "../../hooks/use-marketplace-updates.js";

describe("MarketplaceUpdateBanner", () => {
  afterEach(() => cleanup());

  it("lists plugin names when multiple updates are available", () => {
    render(
      <MarketplaceUpdateBanner
        updates={[
          update("meeting", "LVIS Meeting", "2.0.0"),
          update("calendar", "LVIS Calendar", "1.4.0"),
          update("email", "LVIS Email", "3.1.0"),
        ]}
        onDismiss={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    const banner = screen.getByTestId("marketplace-update-banner");
    expect(banner.textContent).toContain("3개 플러그인 업데이트 가능");
    expect(banner.textContent).toContain("LVIS Meeting (meeting) → 2.0.0");
    expect(banner.textContent).toContain("LVIS Calendar (calendar) → 1.4.0");
    expect(banner.textContent).toContain("LVIS Email (email) → 3.1.0");
  });

  it("falls back to plugin id when a display name is missing", () => {
    render(
      <MarketplaceUpdateBanner
        updates={[{ pluginId: "local-indexer", installedVersion: "1.0.0", latestVersion: "1.1.0" }]}
        onDismiss={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.getByTestId("marketplace-update-banner").textContent).toContain(
      "local-indexer → 1.1.0",
    );
  });
});

function update(pluginId: string, pluginName: string, latestVersion: string): PluginUpdateInfo {
  return {
    pluginId,
    pluginName,
    installedVersion: "1.0.0",
    latestVersion,
  };
}
