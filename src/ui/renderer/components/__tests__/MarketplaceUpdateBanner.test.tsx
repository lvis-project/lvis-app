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
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith("meeting", "0.5.24", undefined));
  });

  it("requires networkAccess disclosure before updating a network-enabled plugin", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(
      <MarketplaceUpdateBanner
        updates={[{
          ...update("network-plug", "Network Plug", "2.0.0"),
          networkAccess: {
            allowedDomains: ["api.example.com"],
            reasoning: "Needs API access to sync user data.",
          },
        }]}
        onDismiss={vi.fn()}
        onSkip={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    screen.getByTestId("marketplace-update-action").click();
    await vi.waitFor(() => expect(screen.getByTestId("plugin-install-network-access").textContent).toContain("Needs API access"));
    expect(onUpdate).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "설치" }).click();

    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
      "network-plug",
      "2.0.0",
      { networkAccessAcknowledgement: { allowedDomains: ["api.example.com"] } },
    ));
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

  it("dismisses the banner when every update in the batch succeeds", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const onDismiss = vi.fn();
    const onResolved = vi.fn();
    render(
      <MarketplaceUpdateBanner
        updates={[update("meeting", "LVIS Meeting", "2.0.0"), update("calendar", "LVIS Calendar", "1.4.0")]}
        onDismiss={onDismiss}
        onSkip={vi.fn()}
        onUpdate={onUpdate}
        onResolved={onResolved}
      />,
    );

    screen.getByTestId("marketplace-update-action").click();

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.queryByTestId("marketplace-update-partial-failure")).toBeNull();
  });

  it("keeps failed updates for retry and reports succeeded ids on partial failure", async () => {
    const onUpdate = vi.fn(async (pluginId: string) => {
      if (pluginId === "calendar") throw new Error("download failed");
    });
    const onDismiss = vi.fn();
    const onResolved = vi.fn();
    render(
      <MarketplaceUpdateBanner
        updates={[
          update("meeting", "LVIS Meeting", "2.0.0"),
          update("calendar", "LVIS Calendar", "1.4.0"),
        ]}
        onDismiss={onDismiss}
        onSkip={vi.fn()}
        onUpdate={onUpdate}
        onResolved={onResolved}
      />,
    );

    screen.getByTestId("marketplace-update-action").click();

    const failure = await screen.findByTestId("marketplace-update-partial-failure");
    // "성공 1 · 실패 1 (LVIS Calendar (calendar))" — success/failure counts split out.
    expect(failure.textContent).toContain("성공 1");
    expect(failure.textContent).toContain("실패 1");
    expect(failure.textContent).toContain("LVIS Calendar (calendar)");
    // The one that failed carries its message in the hover detail.
    expect(failure.getAttribute("title")).toContain("download failed");
    // Succeeded rows are pruned from the visible list; the banner stays for retry.
    expect(onResolved).toHaveBeenCalledWith(["meeting"]);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("marketplace-update-action").textContent).toContain("재시도");
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
