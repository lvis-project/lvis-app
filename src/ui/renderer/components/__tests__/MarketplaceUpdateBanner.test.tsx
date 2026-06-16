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
        onSkip={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    const banner = screen.getByTestId("marketplace-update-banner");
    expect(banner.textContent).toContain("3개 플러그인 업데이트 가능");
    expect(banner.textContent).toContain("LVIS Meeting (meeting) → 2.0.0");
    expect(banner.textContent).toContain("LVIS Calendar (calendar) → 1.4.0");
    expect(banner.textContent).toContain("LVIS Email (email) → 3.1.0");
  });

  it("passes the expected latest version to the update action", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(
      <MarketplaceUpdateBanner
        updates={[update("meeting", "LVIS Meeting", "0.5.24")]}
        onDismiss={vi.fn()}
        onSkip={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    screen.getByTestId("marketplace-update-action").click();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith("meeting", "0.5.24"));
  });
  it("falls back to plugin id when a display name is missing", () => {
    render(
      <MarketplaceUpdateBanner
        updates={[{ pluginId: "local-indexer", installedVersion: "1.0.0", latestVersion: "1.1.0" }]}
        onDismiss={vi.fn()}
        onSkip={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.getByTestId("marketplace-update-banner").textContent).toContain(
      "local-indexer → 1.1.0",
    );
  });

  it("uses the close control as a skip-until-next-version action", () => {
    const onSkip = vi.fn();
    const onDismiss = vi.fn();
    render(
      <MarketplaceUpdateBanner
        updates={[update("meeting", "LVIS Meeting", "0.5.24")]}
        onDismiss={onDismiss}
        onSkip={onSkip}
        onUpdate={vi.fn()}
      />,
    );

    screen.getByLabelText("이 플러그인 업데이트를 다음 버전까지 건너뛰기").click();

    expect(onSkip).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
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
