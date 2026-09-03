import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import type { MarketplaceAnnouncement } from "../../src/shared/marketplace-announcements.js";

/**
 * What an announcement's button is allowed to do.
 *
 * An announcement is content fetched from the marketplace and shown on every
 * install. A button that changed a setting would therefore be a path from a
 * marketplace post into this machine's configuration, so the button only
 * NAVIGATES — to a settings tab, or to a page in the user's browser — and the
 * user flips the switch themselves once they are looking at it.
 *
 * Driven through the real producer: the announcement arrives on the IPC channel
 * the host pushes it on, and the assertion is on what the app then calls. A
 * test on the handler alone could not see a settings write added anywhere else
 * along the click.
 */
describe("marketplace announcement actions", () => {
  afterEach(() => vi.restoreAllMocks());

  function announcement(
    actions: MarketplaceAnnouncement["actions"],
  ): MarketplaceAnnouncement {
    return {
      id: 1,
      title: "OS tool sandbox",
      body: "Shell tools can now run inside a sandbox.",
      level: "info",
      createdAt: "2026-09-03T00:00:00Z",
      startsAt: null,
      endsAt: null,
      actions,
    };
  }

  async function pushAnnouncement(
    api: Awaited<ReturnType<typeof renderApp>>["api"],
    item: MarketplaceAnnouncement,
  ) {
    const listener = api.onMarketplaceAnnouncements.mock.calls[0]?.[0] as
      | ((items: MarketplaceAnnouncement[]) => void)
      | undefined;
    expect(listener).toBeDefined();
    await act(async () => {
      listener!([item]);
    });
  }

  it("takes the user to the settings tab and writes no settings", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    api.updateSettings.mockClear();

    await pushAnnouncement(
      api,
      announcement([
        {
          label: { ko: "샌드박스 설정 열기", en: "Open sandbox settings" },
          target: { kind: "settings", settingsTab: "permissions" },
        },
      ]),
    );

    const button = await waitFor(() => {
      const el = container.querySelector('[data-testid="marketplace-announcement-action-0"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    await act(async () => {
      button.click();
    });

    // The destination the button named — the settings panel's Permissions page,
    // named by the breadcrumb that describes where the window is.
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="view-path-current-settings:permissions"]'),
      ).not.toBeNull();
    });
    // Navigation, not configuration: nothing about the permission block was
    // written, and the browser was not sent anywhere either.
    expect(
      api.updateSettings.mock.calls.some(([patch]) =>
        Object.prototype.hasOwnProperty.call(patch as object, "permissions"),
      ),
    ).toBe(false);
    expect(api.openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens a url action through the external-url sink and writes no settings", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    api.updateSettings.mockClear();

    await pushAnnouncement(
      api,
      announcement([
        {
          label: { ko: "안내 문서", en: "Read the guide" },
          target: { kind: "url", url: "https://example.com/guide" },
        },
      ]),
    );

    const button = await waitFor(() => {
      const el = container.querySelector('[data-testid="marketplace-announcement-action-0"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    await act(async () => {
      button.click();
    });

    expect(api.openExternalUrl).toHaveBeenCalledWith("https://example.com/guide");
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
});
