/**
 * The built-in views are panes.
 *
 * A view used to draw its own page: an `<h2>` at the top of the body, its
 * global controls beside that heading, and its own page padding. The
 * conversation beside it, meanwhile, sat in a framed pane with a 36px header
 * that carried its title and its actions. Two shapes for the same thing.
 *
 * These tests pin the one shape: the view is the BODY of a pane, the frame
 * carries its name and its glyph, the controls that stood beside the heading
 * are in the frame's header, and closing the pane hands it back to the
 * conversation it was covering rather than closing anything.
 *
 * Driven through the real producers — a restored location, a sidebar click, a
 * click on the frame's close control — because the claim is about what the
 * user sees and does, not about which props a branch passes.
 */
import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { atHome, renderApp } from "./render-app.js";
import { settingsWithActiveView } from "./helpers.js";
import { t } from "../../src/i18n/runtime.js";
import { BUILTIN_LABEL_KEYS, type FeatureViewKey } from "../../src/ui/renderer/utils/view-location.js";

afterEach(() => vi.restoreAllMocks());

/**
 * The pane the router drew for the active view, or null while it has none.
 *
 * `main-pane-shell` alone would not do: the conversation surface is one too and
 * is in the DOM at the same time (hidden, not unmounted), and its tile is also
 * a `chat-group`. `data-view` is what says which shell is the view's.
 */
function pane(container: HTMLElement): HTMLElement | null {
  return container.querySelector(
    '[data-testid="main-pane-shell"][data-view] [data-testid="chat-group"]',
  );
}

function paneTitle(container: HTMLElement): string | null {
  return pane(container)
    ?.querySelector('[data-testid="chat-group-header"] h2')
    ?.textContent
    ?.trim() ?? null;
}

/**
 * The conversations stay MOUNTED behind a view — a tile subscribes to its
 * group's stream when it mounts. "At home" is therefore whether the surface is
 * SHOWING, not whether it exists.
 */
async function openView(view: FeatureViewKey, bodyTestId: string) {
  const rendered = await renderApp({
    hasApiKey: true,
    settings: settingsWithActiveView(view),
  });
  await waitFor(() => {
    expect(pane(rendered.container)).not.toBeNull();
    expect(rendered.container.querySelector(`[data-testid="${bodyTestId}"]`)).not.toBeNull();
  });
  return rendered;
}

// view key → the body it draws, identified by something the view itself owns.
const VIEWS: ReadonlyArray<readonly [FeatureViewKey, string]> = [
  ["work-board", "work-board-panel"],
  ["routines", "routine-panel"],
  ["insights", "insights-scroll-root"],
  ["memory", "memory-search-panel"],
];

describe("built-in views are pane bodies", () => {
  it.each(VIEWS)("draws %s inside a pane whose header carries its own label", async (view, bodyTestId) => {
    const { container } = await openView(view, bodyTestId);

    // The frame's title is the label the sidebar and the path already use for
    // this destination — read from the same map, so a renamed view cannot be
    // one thing in the rail and another on the pane.
    expect(paneTitle(container)).toBe(t(BUILTIN_LABEL_KEYS[view]));
    // …and the glyph beside it. Read as "an icon is drawn", not as which one:
    // which glyph is the map's business, and asserting it here would only
    // restate the map.
    expect(
      pane(container)?.querySelector('[data-testid="chat-group-header"] svg'),
    ).not.toBeNull();
  });

  it.each(VIEWS)("leaves no heading of its own inside the %s body", async (view, bodyTestId) => {
    const { container } = await openView(view, bodyTestId);

    // Exactly one h2 in the pane: the frame's. A body that kept its own would
    // name the view twice, 36px apart.
    expect(pane(container)?.querySelectorAll("h2").length).toBe(1);
    expect(
      container.querySelector(`[data-testid="${bodyTestId}"]`)?.querySelector("h2"),
    ).toBeNull();
  });

  it.each(VIEWS)("insets the %s body once, from the frame", async (view, bodyTestId) => {
    const { container } = await openView(view, bodyTestId);

    // The page inset is the frame's `bodyInset="page"` and nothing else: the
    // PageShell that used to add it is gone, so a body that still carried its
    // own would sit twice as far in.
    const inset = pane(container)?.querySelectorAll('[data-body-inset="page"]') ?? [];
    expect(inset.length).toBe(1);
    expect(inset[0]?.className).toContain("p-4");
    expect(container.querySelector('[data-testid="main-pane-shell"][data-view]')?.className)
      .not.toContain("p-4");
  });
});

describe("a view's global actions live in the pane header", () => {
  it("carries the work board's new-item and refresh controls", async () => {
    const { container } = await openView("work-board", "work-board-panel");
    const header = pane(container)?.querySelector('[data-testid="chat-group-header"]');

    const add = header?.querySelector('[data-testid="chat-group-action-work-board-add"]');
    expect(add).not.toBeNull();
    expect(add?.getAttribute("aria-label")).toBe(t("workBoard.addItemButton"));
    expect(header?.querySelector('[data-testid="chat-group-action-work-board-refresh"]')).not.toBeNull();

    // The control still opens what it opened when it stood beside the heading.
    await act(async () => {
      fireEvent.click(add as HTMLElement);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="work-board-create-dialog"]')).not.toBeNull();
    });
  });

  it("carries the routines' new-routine and refresh controls", async () => {
    const { container } = await openView("routines", "routine-panel");
    const header = pane(container)?.querySelector('[data-testid="chat-group-header"]');

    expect(header?.querySelector('[data-testid="chat-group-action-routine-add"]')).not.toBeNull();
    expect(header?.querySelector('[data-testid="chat-group-action-routine-refresh"]')).not.toBeNull();
  });

  it("carries the insights' refresh control", async () => {
    const { container } = await openView("insights", "insights-scroll-root");
    const header = pane(container)?.querySelector('[data-testid="chat-group-header"]');

    expect(header?.querySelector('[data-testid="chat-group-action-insights-refresh"]')).not.toBeNull();
  });

  it("gives memory no action it does not have", async () => {
    const { container } = await openView("memory", "memory-search-panel");
    const header = pane(container)?.querySelector('[data-testid="chat-group-header"]');

    // The search box is a body control and stays there; the header invents
    // nothing to fill the space.
    expect(header?.querySelector('[data-testid^="chat-group-action-"]')).toBeNull();
    expect(container.querySelector('[data-testid="memory-search-panel"] input')).not.toBeNull();
  });
});

describe("closing a view's pane", () => {
  it("hands the pane back to the conversation instead of closing it", async () => {
    const { container } = await openView("routines", "routine-panel");
    expect(atHome(container)).toBe(false);

    const close = pane(container)?.querySelector('[data-testid="chat-group-close"]');
    expect(close).not.toBeNull();
    expect(close?.getAttribute("aria-label")).toBe(t("chatGroup.close"));

    await act(async () => {
      fireEvent.click(close as HTMLElement);
    });

    // Back on `home`: the pane is the conversation's again, and the router
    // draws no view pane at all.
    await waitFor(() => {
      expect(atHome(container)).toBe(true);
      expect(pane(container)).toBeNull();
    });
    expect(container.querySelector('[data-testid="view-path-current-home"]')).not.toBeNull();
  });
});
