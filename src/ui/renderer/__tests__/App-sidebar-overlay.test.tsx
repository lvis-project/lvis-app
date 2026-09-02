/**
 * Chat mode floats the expanded sidebar over the single conversation tile;
 * work mode keeps it a pushed sibling. The shell derives which from the mode
 * verdict alone, so these lock the three surfaces that geometry touches — the
 * sidebar card, `<main>`'s leading reserve, and the title band's lead — plus
 * the overlay's transient-surface behaviour (focus in, Escape / outside
 * pointer down out, focus back to the toggle).
 *
 * Harness conventions follow App-app-mode.test.tsx; the pre-paint mode seed
 * follows test/renderer/tile-scoped-surfaces.test.tsx.
 */
import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp, startInChatMode } from "../../../../test/renderer/render-app.js";
import {
  BAND_EDGE_PAD,
  CONTENT_TITLE_INSET,
  SHELL_GUTTER,
  collapsedBandLeadClearance,
} from "../../../shared/shell-geometry.js";
import { SIDEBAR_DEFAULT_WIDTH } from "../../../shared/side-panel.js";


/** jsdom has no OS lights: the band's collapsed lead is the plain-platform one. */
const COLLAPSED_BAND_LEAD = `${Math.max(BAND_EDGE_PAD, collapsedBandLeadClearance(false))}px`;
const EXPANDED_BAND_LEAD = `${SIDEBAR_DEFAULT_WIDTH + SHELL_GUTTER + CONTENT_TITLE_INSET}px`;
const EXPANDED_MAIN_RESERVE = `${SIDEBAR_DEFAULT_WIDTH + SHELL_GUTTER}px`;

async function mountShell(container: HTMLElement) {
  const toggle = await waitFor(() => {
    const el = container.querySelector('[data-testid="sidebar-collapse-toggle"]');
    expect(el).not.toBeNull();
    return el as HTMLButtonElement;
  });
  const aside = container.querySelector('[data-testid="primary-sidebar"]') as HTMLElement;
  const main = container.querySelector("main") as HTMLElement;
  const band = container.querySelector('[data-testid^="custom-titlebar"]') as HTMLElement;
  expect(aside).toBeTruthy();
  expect(main).toBeTruthy();
  expect(band).toBeTruthy();
  return { toggle, aside, main, band };
}

function expectCollapsedGeometry(main: HTMLElement, band: HTMLElement) {
  expect(main.classList.contains("pl-(--shell-collapsed-rail-reserve)")).toBe(true);
  expect(main.style.paddingLeft).toBe("");
  expect(band.style.paddingLeft).toBe(COLLAPSED_BAND_LEAD);
}

describe("App sidebar overlay (chat mode)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("chat mode: expanding the sidebar floats the card over the tile — <main> and the band keep the collapsed geometry", async () => {
    const restoreMode = startInChatMode();
    try {
      const { container } = await renderApp({ hasApiKey: true });
      const { toggle, aside, main, band } = await mountShell(container);

      // Chat mode seeds the rail collapsed; nothing overlays yet.
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false);
      expect(main.hasAttribute("data-sidebar-overlay")).toBe(false);
      expectCollapsedGeometry(main, band);

      await act(async () => { fireEvent.click(toggle); });

      await waitFor(() => {
        expect(aside.getAttribute("data-sidebar-overlay")).toBe("true");
      });
      expect(main.getAttribute("data-sidebar-overlay")).toBe("true");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      // The card is the expanded card — same width preference as the pushed one.
      const card = container.querySelector('[data-testid="sidebar-card"]') as HTMLElement;
      expect(card.getAttribute("data-surface")).toBe("card");
      expect(card.style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
      // The surface under it did not move: no reserve grew, no lead moved.
      expectCollapsedGeometry(main, band);
      // The card takes focus when it opens.
      expect(card.contains(document.activeElement)).toBe(true);
    } finally {
      restoreMode();
    }
  });

  it("chat mode: Escape collapses the overlay and hands focus back to the toggle", async () => {
    const restoreMode = startInChatMode();
    try {
      const { container } = await renderApp({ hasApiKey: true });
      const { toggle, aside, main, band } = await mountShell(container);

      await act(async () => { fireEvent.click(toggle); });
      await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));

      await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });

      await waitFor(() => expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false));
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      expect(main.hasAttribute("data-sidebar-overlay")).toBe(false);
      expectCollapsedGeometry(main, band);
      expect(document.activeElement).toBe(toggle);
    } finally {
      restoreMode();
    }
  });

  it("chat mode: a pointer down on the content beside the card collapses it; one inside the card does not", async () => {
    const restoreMode = startInChatMode();
    try {
      const { container } = await renderApp({ hasApiKey: true });
      const { toggle, aside, main } = await mountShell(container);

      await act(async () => { fireEvent.click(toggle); });
      await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));

      // Inside the card: stays open.
      const card = container.querySelector('[data-testid="sidebar-card"]') as HTMLElement;
      await act(async () => { fireEvent.pointerDown(card); });
      expect(aside.getAttribute("data-sidebar-overlay")).toBe("true");

      // Beside it, on the content: collapses.
      await act(async () => { fireEvent.pointerDown(main); });
      await waitFor(() => expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false));
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
    } finally {
      restoreMode();
    }
  });

  it("work mode: the expanded sidebar stays a pushed sibling — no overlay, reserve and lead follow the card width", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    const { toggle, aside, main, band } = await mountShell(container);

    // Work mode seeds the rail expanded.
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false);
    expect(main.hasAttribute("data-sidebar-overlay")).toBe(false);
    expect(main.classList.contains("pl-(--shell-collapsed-rail-reserve)")).toBe(false);
    expect(main.style.paddingLeft).toBe(EXPANDED_MAIN_RESERVE);
    expect(band.style.paddingLeft).toBe(EXPANDED_BAND_LEAD);

    // Escape is not an overlay lever here.
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(main.style.paddingLeft).toBe(EXPANDED_MAIN_RESERVE);
  });

  it("mode flip while the overlay is open re-lays the shell from the verdict: work pushes, chat overlays", async () => {
    const restoreMode = startInChatMode();
    try {
      const { container } = await renderApp({ hasApiKey: true });
      const { toggle, aside, main, band } = await mountShell(container);

      await act(async () => { fireEvent.click(toggle); });
      await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));

      // → work: the same expanded card becomes a pushed sibling.
      await act(async () => {
        fireEvent.click(container.querySelector('[data-testid="app-mode-work"]')!);
      });
      await waitFor(() => expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false));
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      expect(main.style.paddingLeft).toBe(EXPANDED_MAIN_RESERVE);
      expect(band.style.paddingLeft).toBe(EXPANDED_BAND_LEAD);

      // → chat: the transition collapses the rail (existing per-transition
      // default); expanding it again overlays.
      await act(async () => {
        fireEvent.click(container.querySelector('[data-testid="app-mode-chat"]')!);
      });
      await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
      expectCollapsedGeometry(main, band);
      await act(async () => { fireEvent.click(toggle); });
      await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));
      expectCollapsedGeometry(main, band);
    } finally {
      restoreMode();
    }
  });
});
