/**
 * The routed views are panes — the app's own, and a plugin's.
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
import {
  activeSettingsTab,
  clickSettingsTab,
  clickSidebarNavRow,
  settingsWithActiveView,
  splitIntoTwoTiles,
} from "./helpers.js";
import { t } from "../../src/i18n/runtime.js";
import { BUILTIN_LABEL_KEYS, type PaneViewKey } from "../../src/ui/renderer/utils/view-location.js";

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

async function openView(view: PaneViewKey, bodyTestId: string) {
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
const VIEWS: ReadonlyArray<readonly [PaneViewKey, string]> = [
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

describe("a plugin view is a pane body", () => {
  const PLUGIN_ID = "token-plugin";
  const PLUGIN_VIEW_KEY = `plugin:${PLUGIN_ID}:main`;
  const PLUGIN_LABEL = "Token Plugin";
  const PLUGIN_DESCRIPTION = "What this extension is for";

  /**
   * A plugin whose runtime is loaded and whose one UI extension is registered —
   * the state in which its view is a place the window can be.
   */
  const pluginFixture = {
    pluginCards: [{
      id: PLUGIN_ID,
      name: PLUGIN_LABEL,
      description: PLUGIN_DESCRIPTION,
      sampleTools: [],
      capabilities: [],
      tools: [],
      loadStatus: "loaded" as const,
    }],
    pluginUiExtensions: [{
      pluginId: PLUGIN_ID,
      extension: {
        id: "main",
        slot: "sidebar",
        kind: "embedded-module",
        title: PLUGIN_LABEL,
        description: PLUGIN_DESCRIPTION,
        entry: "dist/ui.js",
      },
      entryUrl: "file:///token-plugin/dist/ui.js",
    }],
  };

  async function openPluginView() {
    const rendered = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView(PLUGIN_VIEW_KEY),
      ...pluginFixture,
    });
    await waitFor(() => {
      expect(pane(rendered.container)).not.toBeNull();
      expect(rendered.container.querySelector('[data-testid="plugin-page-shell"]')).not.toBeNull();
    });
    return rendered;
  }

  it("frames the plugin under its manifest label, with its description on the title", async () => {
    const { container } = await openPluginView();

    expect(paneTitle(container)).toBe(PLUGIN_LABEL);
    // The description was a second line of page chrome under the heading. It is
    // the title's tooltip now — still there, costing the pane no height.
    expect(
      pane(container)?.querySelector('[data-testid="chat-group-header"] h2')?.getAttribute("title"),
    ).toBe(PLUGIN_DESCRIPTION);
    // The glyph the sidebar row draws for this plugin, resolved from the same
    // manifest fields. Read as "an icon is drawn": which one is the resolver's
    // business.
    expect(
      pane(container)?.querySelector('[data-testid="chat-group-header"] svg'),
    ).not.toBeNull();
  });

  it("draws one box — the frame's — around the plugin surface", async () => {
    const { container } = await openPluginView();

    // The host's own page shell is gone: what carries `plugin-page-shell` is
    // the body wrapper INSIDE the frame, so the plugin's surface has exactly
    // one outline and one header, not a card inside a card.
    const shell = container.querySelector('[data-testid="plugin-page-shell"]');
    expect(pane(container)?.contains(shell as Node)).toBe(true);
    expect(shell?.querySelector("h2")).toBeNull();
    expect(pane(container)?.querySelectorAll("h2").length).toBe(1);
  });

  it("unmounts the plugin surface when the pane goes back to the conversation", async () => {
    // The conversation is the ONE surface kept mounted while hidden — its
    // stream subscription and composer draft live in it. A plugin guest is a
    // whole renderer process, so it leaves with its pane and pays for the
    // return with a reload.
    const { container } = await openPluginView();
    expect(atHome(container)).toBe(false);

    await act(async () => {
      fireEvent.click(pane(container)?.querySelector('[data-testid="chat-group-close"]') as HTMLElement);
    });

    await waitFor(() => {
      expect(atHome(container)).toBe(true);
      expect(container.querySelector('[data-testid="plugin-page-shell"]')).toBeNull();
    });
    expect(pane(container)).toBeNull();
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

/**
 * Settings is a pane body too — with one difference the tests below pin.
 *
 * It is the only built-in view that lays out REGIONS of its own: a nav column
 * and a detail pane, split by a full-height divider, which at a narrow pane
 * width becomes a two-depth list→detail stack. That structure is the user's
 * (they asked to keep it) and it needs the frame's hairline: an inset body
 * would float the divider inside the outline instead of reaching it. So the
 * frame gives Settings `bodyInset="none"` and the padding stays where Settings
 * already put it, inside each of its two regions.
 */
const SETTINGS_SHELL = "[data-settings-layout]";

async function openSettingsPane(settingsTab?: string) {
  const rendered = await renderApp({
    hasApiKey: true,
    settings: settingsWithActiveView("settings", settingsTab),
  });
  await waitFor(() => {
    expect(pane(rendered.container)).not.toBeNull();
    expect(rendered.container.querySelector(SETTINGS_SHELL)).not.toBeNull();
  });
  return rendered;
}

describe("settings is a pane body", () => {
  it("draws it inside a pane whose header carries its label and glyph", async () => {
    const { container } = await openSettingsPane();

    expect(container.querySelector('[data-testid="main-pane-shell"][data-view="settings"]')).not.toBeNull();
    expect(paneTitle(container)).toBe(t(BUILTIN_LABEL_KEYS.settings));
    expect(
      pane(container)?.querySelector('[data-testid="chat-group-header"] svg'),
    ).not.toBeNull();
  });

  it("names the place once — the panel keeps no title of its own", async () => {
    const { container } = await openSettingsPane();
    const label = t(BUILTIN_LABEL_KEYS.settings);

    // The pane's own name appears in exactly one heading: the frame's. The
    // panel used to repeat it at the top of its nav column, 36px below.
    const named = [...(pane(container)?.querySelectorAll("h2") ?? [])]
      .filter((h) => h.textContent?.trim() === label);
    expect(named.length).toBe(1);
    expect(named[0]?.closest('[data-testid="chat-group-header"]')).not.toBeNull();
    // The ACTIVE PAGE's heading stays: it names the tab, a depth below the
    // pane, exactly as the location path reads it (Settings › …).
    expect(container.querySelector(`${SETTINGS_SHELL} h2`)).not.toBeNull();
  });

  it("insets the body by nothing, so its two regions reach the frame", async () => {
    const { container } = await openSettingsPane();

    const body = pane(container)?.querySelector('[data-body-inset]');
    expect(body?.getAttribute("data-body-inset")).toBe("none");
    expect(pane(container)?.querySelector('[data-body-inset="page"]')).toBeNull();
    // Nothing but the panel's own root stands between the frame's body and the
    // layout it draws, and that root adds no margin. The page wrapper the panel
    // used to bring — three nested boxes ending in `px-3 pt-4 sm:px-4` — is
    // gone, so the padding has exactly one home: the two regions themselves.
    const shell = container.querySelector<HTMLElement>(SETTINGS_SHELL);
    const between: HTMLElement[] = [];
    for (let el = shell?.parentElement ?? null; el && el !== body; el = el.parentElement) between.push(el);
    expect(between.length).toBe(1);
    expect(between.every((el) => !/(?:^|\s)-?p[xytblre]?-/.test(el.className))).toBe(true);
  });

  it("keeps the tab the user picks, and reports it outward", async () => {
    const { container, api } = await openSettingsPane();
    expect(activeSettingsTab(container)).toBe("llm");

    await act(async () => {
      clickSettingsTab(container, "permissions");
    });

    await waitFor(() => {
      expect(activeSettingsTab(container)).toBe("permissions");
      // The move is persisted under the key it has always used, and the
      // location path follows it — the pane did not swallow either.
      expect(api.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ system: expect.objectContaining({ settingsTab: "permissions" }) }),
      );
      expect(container.querySelector('[data-testid="view-path-current-settings:permissions"]')).not.toBeNull();
    });
  });

  it("draws the view in the pane that holds it and leaves its neighbour alone", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    // Focus follows a split, so the view opens in the SECOND tile.
    const [left, right] = await splitIntoTwoTiles(container);
    const cell = (chatGroupId: string) =>
      container.querySelector<HTMLElement>(`[data-testid="chat-group-cell:${chatGroupId}"]`)!;

    await clickSidebarNavRow("features", "toolbar-work-board");

    // The board took ONE pane's box — the one that was focused.
    await waitFor(() => {
      expect(cell(right!.chatGroupId)
        .querySelector('[data-testid="main-pane-shell"][data-view="work-board"]')).not.toBeNull();
    });
    // Its neighbour is untouched: still a conversation, still drawn. Before the
    // route moved onto the canvas the whole surface went `display:none` here,
    // so the second pane went dark for a view it was not showing.
    expect(cell(left!.chatGroupId)
      .querySelector('[data-testid="main-pane-shell"][data-view]')).toBeNull();
    expect(cell(left!.chatGroupId).querySelector('[data-testid="chat-group"]')).not.toBeNull();

    // Two frames in that one cell: the board's, and the conversation it covers.
    // The covered one is hidden rather than unmounted — its turn may still be
    // streaming, and its composer draft and scroll position live in it.
    expect(cell(right!.chatGroupId).querySelectorAll('[data-testid="chat-group"]')).toHaveLength(2);
  });

  it("hands the pane back to the conversation when closed", async () => {
    const { container } = await openSettingsPane();
    expect(atHome(container)).toBe(false);

    await act(async () => {
      fireEvent.click(pane(container)?.querySelector('[data-testid="chat-group-close"]') as HTMLElement);
    });

    await waitFor(() => {
      expect(atHome(container)).toBe(true);
      expect(container.querySelector(SETTINGS_SHELL)).toBeNull();
    });
  });
});
