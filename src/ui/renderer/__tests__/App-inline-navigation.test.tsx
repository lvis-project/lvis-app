import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collapsedBandLeadClearance } from "../../../shared/shell-geometry.js";
import { clickSidebarNavRow, openSidebarGroup, sidebarNavRowActive } from "../../../../test/renderer/helpers.js";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";

/**
 * Selecting a view renders it inline — in chat mode too.
 *
 * Chat mode used to answer a navigation click by opening a second window and
 * returning WITHOUT setting `activeView`. Two things followed: the main window
 * had no way to say where it was (it stayed on `home` while the user was
 * looking at the work board), and the sidebar's own active highlight, which is
 * derived from `activeView`, could never light up for a destination opened in
 * chat mode.
 *
 * Driven through the real producer — the app-mode toggle and a sidebar click —
 * because the claim is about what a user's click does end to end, not about
 * what a routing function returns.
 */
describe("App inline navigation", () => {
  afterEach(() => vi.restoreAllMocks());

  async function switchToChatMode(container: HTMLElement) {
    const chatBtn = await waitFor(() => {
      const el = container.querySelector('[data-testid="app-mode-chat"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(chatBtn);
    });
    await waitFor(() => expect(chatBtn.getAttribute("aria-pressed")).toBe("true"));
  }

  // The built-in views live in the Features group's flyout in BOTH sidebar
  // states — the collapsed rail opens the same flyout from its icon, so
  // nothing has to expand. Rows render in a portal: read them from `document`.
  async function openFeaturesFlyout(container: HTMLElement) {
    expect(container.querySelector('[data-testid="sidebar-group-features"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="toolbar-work-board"]')).toBeNull();
    await openSidebarGroup("features");
    await waitFor(() => {
      expect(document.querySelector('[data-testid="toolbar-work-board"]')).not.toBeNull();
    });
  }

  it("renders a built-in view inline in chat mode and lights up its sidebar entry", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await switchToChatMode(container);
    await openFeaturesFlyout(container);

    const workBoardNav = document.querySelector('[data-testid="toolbar-work-board"]') as HTMLButtonElement;
    // Nothing is selected yet, so the entry starts unlit — otherwise the
    // assertion below could pass on a highlight that was never off.
    expect(workBoardNav.getAttribute("aria-current")).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-group-features"]')?.getAttribute("data-active")).toBeNull();

    await act(async () => {
      fireEvent.click(workBoardNav);
    });

    // Inline: the main pane switched off the chat surface. Visit history is
    // owned by the top toolbar, so the content surface has no duplicate back.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="main-pane-shell"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="view-path-current-work-board"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="main-content-back"]')).toBeNull();
    // Hidden, not unmounted: a tile subscribes to its group's stream when it
    // mounts, so swapping it out for the work board would drop the frames of a
    // turn still in flight — along with the composer draft and scroll position.
    expect(
      container.querySelector('[data-testid="chat-surface"]')?.getAttribute("data-visible"),
    ).toBe("false");

    // The pick closed the flyout; the group now reports the page as one of its
    // rows, and the row itself says so once the flyout is opened again.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-group-features-menu"]')).toBeNull();
      expect(container.querySelector('[data-testid="sidebar-group-features"]')?.getAttribute("data-active")).toBe("true");
    });
    expect(await sidebarNavRowActive("features", "toolbar-work-board")).toBe(true);
    // The rail stayed collapsed — the flyout needed no expansion.
    expect(container.querySelector('[data-testid="sidebar-card"]')?.getAttribute("data-surface")).toBe("bare");
  });

  it("renders the same view inline in work mode — the two modes no longer differ here", async () => {
    // Work mode already behaved this way; pinning it makes the convergence the
    // assertion rather than a coincidence of which mode the test happened to
    // start in (the default is work).
    const { container } = await renderApp({ hasApiKey: true });
    await clickSidebarNavRow("features", "sidebar-routines");

    await waitFor(() => {
      expect(container.querySelector('[data-testid="sidebar-group-features"]')?.getAttribute("data-active")).toBe("true");
    });
    expect(await sidebarNavRowActive("features", "sidebar-routines")).toBe(true);
  });

  it("keeps navigating inline after a mode switch, in both directions", async () => {
    const { container } = await renderApp({ hasApiKey: true });

    // work → select → chat → select: the previously mode-dependent branch would
    // have taken a different path on the second selection.
    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => {
      expect(container.querySelector('[data-testid="view-path-current-work-board"]')).not.toBeNull();
    });
    expect(await sidebarNavRowActive("features", "toolbar-work-board")).toBe(true);

    await switchToChatMode(container);

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => {
      expect(container.querySelector('[data-testid="view-path-current-routines"]')).not.toBeNull();
    });
    expect(await sidebarNavRowActive("features", "sidebar-routines")).toBe(true);
    expect(await sidebarNavRowActive("features", "toolbar-work-board")).toBe(false);
  });

  it("starts the band's path past the sidebar's bare cluster strip once the rail is collapsed", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    // jsdom has no preload bridge, so the band is the plain variant and the
    // platform is not darwin — the same two facts the clearance is asked with.
    const band = await waitFor(() => {
      const el = container.querySelector('[data-testid="custom-titlebar-plain"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(band.querySelector('[data-testid="view-path-breadcrumb"]')).not.toBeNull();
    const expandedLead = Number.parseFloat(band.style.paddingLeft);

    await switchToChatMode(container);

    // Collapsed: the card retracts but its cluster strip stays on the band, so
    // the band pads past that strip (CDP: `view-path-breadcrumb`.left must be
    // >= `sidebar-cluster`.right + SHELL_GUTTER) instead of the rail reserve.
    await waitFor(() => {
      expect(band.style.paddingLeft).toBe(`${collapsedBandLeadClearance(false)}px`);
    });
    expect(container.querySelector('[data-testid="sidebar-cluster"]')).not.toBeNull();
    expect(collapsedBandLeadClearance(false)).toBeLessThan(expandedLead);
  });
});
