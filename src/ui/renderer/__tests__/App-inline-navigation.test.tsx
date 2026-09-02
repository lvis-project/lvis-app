import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  // Chat mode collapses the sidebar to its icon rail, where the built-in views
  // sit behind the Features group icon: clicking it expands the sidebar and
  // opens the group, which is where the rows become clickable.
  async function openFeaturesFromRail(container: HTMLElement) {
    const group = await waitFor(() => {
      const el = container.querySelector('[data-testid="sidebar-group-features"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    expect(container.querySelector('[data-testid="toolbar-work-board"]')).toBeNull();
    await act(async () => {
      fireEvent.click(group);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="toolbar-work-board"]')).not.toBeNull();
    });
  }

  it("renders a built-in view inline in chat mode and lights up its sidebar entry", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await switchToChatMode(container);
    await openFeaturesFromRail(container);

    const workBoardNav = container.querySelector('[data-testid="toolbar-work-board"]') as HTMLButtonElement;
    expect(workBoardNav).toBeTruthy();
    // Nothing is selected yet, so the entry starts unlit — otherwise the
    // assertion below could pass on a highlight that was never off.
    expect(workBoardNav.getAttribute("aria-current")).toBeNull();

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

    // The sidebar entry now reports itself as the current page.
    await waitFor(() => {
      const nav = container.querySelector('[data-testid="toolbar-work-board"]');
      expect(nav?.getAttribute("aria-current")).toBe("page");
    });
  });

  it("renders the same view inline in work mode — the two modes no longer differ here", async () => {
    // Work mode already behaved this way; pinning it makes the convergence the
    // assertion rather than a coincidence of which mode the test happened to
    // start in (the default is work).
    const { container } = await renderApp({ hasApiKey: true });

    const routinesNav = await waitFor(() => {
      const el = container.querySelector('[data-testid="sidebar-routines"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(routinesNav);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="sidebar-routines"]')?.getAttribute("aria-current"))
        .toBe("page");
    });
  });

  it("keeps navigating inline after a mode switch, in both directions", async () => {
    const { container } = await renderApp({ hasApiKey: true });

    // work → select → chat → select: the previously mode-dependent branch would
    // have taken a different path on the second selection.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="toolbar-work-board"]') as HTMLButtonElement);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="toolbar-work-board"]')?.getAttribute("aria-current"))
        .toBe("page");
    });

    await switchToChatMode(container);
    await openFeaturesFromRail(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-routines"]') as HTMLButtonElement);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="sidebar-routines"]')?.getAttribute("aria-current"))
        .toBe("page");
    });
    expect(container.querySelector('[data-testid="toolbar-work-board"]')?.getAttribute("aria-current"))
      .toBeNull();
  });
});
