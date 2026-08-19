/**
 * Restoring the main window's location on launch.
 *
 * The app used to open on `home` every time, no matter where the user was when
 * they closed it. `SystemSettings.activeView` persists the location the same way
 * `sidebarActiveTab` persists its tab; these tests assert the half that matters
 * to a user — **the next launch opens there** — rather than that a write
 * happened.
 *
 * The plugin cases are the reason this needs care. A `plugin:<id>:<viewId>` key
 * stays perfectly well-formed after its plugin is uninstalled, so a restore that
 * only checked the key's shape would open the app on a view that no longer
 * exists. Both directions are covered: present plugin restores, absent plugin
 * falls back to home.
 */
import "./setup.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { activeSettingsTab, deferred, settingsWithActiveView } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const PLUGIN_ID = "example-plugin";
const VIEW_ID = "MainView";
const PLUGIN_VIEW_KEY = `plugin:${PLUGIN_ID}:${VIEW_ID}`;
const PLUGIN_NAV_TESTID = `sidebar-plugin-${PLUGIN_ID}-${VIEW_ID}`;

function sidebarView(pluginId: string, viewId: string) {
  return {
    pluginId,
    extension: {
      id: viewId,
      slot: "sidebar",
      kind: "embedded-module",
      title: "Example",
      entry: "ui/index.js",
      exportName: "mount",
    },
    entryUrl: "file:///c:/plugins/example/dist/ui/index.js",
  };
}


function isActive(container: HTMLElement, testId: string): boolean {
  return container
    .querySelector(`[data-testid="${testId}"]`)
    ?.getAttribute("aria-current") === "page";
}

function atHome(container: HTMLElement): boolean {
  return container.querySelector('[data-testid="composer-textarea"]') !== null;
}

/**
 * Let every pending restore land before concluding that none did.
 *
 * "Still home" is only meaningful once the app has had its chance to navigate:
 * the settings read, the plugin-view load, and the effect that pairs them all
 * resolve asynchronously. Inside `act` so React commits them to the DOM — an
 * unflushed update would leave the old markup in place and make a broken
 * fallback look like a working one.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

describe("restoring activeView on launch", () => {
  it("opens on the built-in view the user left, not home", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("work-board"),
    });

    await waitFor(() => expect(isActive(container, "toolbar-work-board")).toBe(true));
    expect(atHome(container)).toBe(false);
  });

  it("round-trips: the location this run persists is where the next run opens", async () => {
    const first = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(atHome(first.container)).toBe(true));

    // Navigate the way the app itself does, then read back exactly what was
    // persisted — no hand-written settings blob in between.
    await act(async () => {
      first.emitViewActivate("work-board");
    });
    await waitFor(() => expect(isActive(first.container, "toolbar-work-board")).toBe(true));
    await waitFor(() =>
      expect(first.api.updateSettings).toHaveBeenCalledWith({
        system: { activeView: "work-board" },
      }),
    );
    const persisted = await first.api.getSettings();
    first.unmount();

    const second = await renderApp({ hasApiKey: true, settings: persisted });
    await waitFor(() => expect(isActive(second.container, "toolbar-work-board")).toBe(true));
  });

  it("opens on a restored plugin view once its plugin is loaded", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView(PLUGIN_VIEW_KEY),
      pluginUiExtensions: [sidebarView(PLUGIN_ID, VIEW_ID)],
    });

    await waitFor(() => expect(isActive(container, PLUGIN_NAV_TESTID)).toBe(true));
    expect(atHome(container)).toBe(false);
  });

  it("falls back to home when the stored plugin view is no longer installed", async () => {
    const { container, api } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView(PLUGIN_VIEW_KEY),
      // The plugin was uninstalled since the value was written. Its key is
      // still well-formed, so only a check against the LOADED views can catch
      // it — otherwise the app opens on a view that cannot render.
      pluginUiExtensions: [],
    });

    await settle();
    expect(atHome(container)).toBe(true);
    expect(container.querySelector(`[data-testid="${PLUGIN_NAV_TESTID}"]`)).toBeNull();

    // ...and staying home must not COST the user their stored location. The app
    // already bounces an active-but-missing plugin view home, but that path
    // runs through `setActiveView`, so navigating there and being bounced would
    // overwrite `activeView` with "home" — a plugin that merely failed to load
    // this once would erase where the user was. Never entering it keeps the
    // stored value intact for the next launch.
    expect(api.updateSettings).not.toHaveBeenCalledWith({ system: { activeView: "home" } });
  });

  it("falls back to home for a key a previous build could produce but this one cannot", async () => {
    // `reminders` shipped as a real view key and was retired from the table
    // (#1994). That is the shape of the problem this guard exists for: a value
    // written by an older build outlives the key space it came from, and only
    // asking the table — not the string's shape — can tell.
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("reminders"),
    });

    await settle();
    expect(atHome(container)).toBe(true);
  });

  it("falls back to home for a key that is not a view key at all", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("plugin:"),
    });

    await settle();
    expect(atHome(container)).toBe(true);
  });

  it("restores the settings page the user left, not the default one", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("settings", "permissions"),
    });

    await waitFor(() => expect(activeSettingsTab(container)).toBe("permissions"));
  });
});

/**
 * The restore and the user, racing.
 *
 * On a fast launch the stored location is in place before anyone can click, so
 * neither half of this is reachable — every test here holds the settings read
 * open on purpose, which is the only way to be inside the window at all.
 *
 * The pair has to be driven together. "The restore lands" passes on its own
 * with the discard missing, and "the user's choice survives" passes on its own
 * with the restore broken outright; only asserting both catches a guard that
 * bought one by giving up the other.
 */
describe("a launch whose stored location has not arrived yet", () => {
  /** A launch whose settings read is held open until `release()`. */
  function heldLaunch(stored: ReturnType<typeof settingsWithActiveView>) {
    const gate = deferred<void>();
    return {
      release: () => gate.resolve(),
      opts: {
        hasApiKey: true,
        settings: stored,
        getSettings: async () => {
          await gate.promise;
          return stored;
        },
      },
    };
  }

  async function clickNav(container: HTMLElement, testId: string) {
    const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
    expect(el, `missing [data-testid="${testId}"]`).not.toBeNull();
    await act(async () => {
      el!.click();
    });
  }

  it("still lands on the stored view when nobody touches the app", async () => {
    const { release, opts } = heldLaunch(settingsWithActiveView("work-board"));
    const { container } = await renderApp(opts);
    // Rendered, interactive, and NOT yet where it is going — the window the
    // other half of this pair is about.
    await waitFor(() => expect(atHome(container)).toBe(true));

    await act(async () => {
      release();
    });

    await waitFor(() => expect(isActive(container, "toolbar-work-board")).toBe(true));
  });

  it("keeps the view the user picked while the read was still in flight", async () => {
    const { release, opts } = heldLaunch(settingsWithActiveView("work-board"));
    const { container } = await renderApp(opts);
    await waitFor(() => expect(atHome(container)).toBe(true));

    await clickNav(container, "sidebar-routines");
    await waitFor(() => expect(isActive(container, "sidebar-routines")).toBe(true));

    // The stored location arrives second. Applying it now would take the screen
    // the user is on away from them, for a value they have already superseded.
    await act(async () => {
      release();
    });
    await settle();

    expect(isActive(container, "sidebar-routines")).toBe(true);
    expect(isActive(container, "toolbar-work-board")).toBe(false);
  });

  it("holds a restored PLUGIN view back for good once the user has picked a view", async () => {
    const { release, opts } = heldLaunch(settingsWithActiveView(PLUGIN_VIEW_KEY));
    const { container } = await renderApp({
      ...opts,
      // The plugin is installed and its view does load — so the only thing
      // keeping the app off it is the user's own navigation. Without the
      // discard, this restore lands LATER than the built-in one (it waits for
      // the view list), which is the longer window, not a safer one.
      pluginUiExtensions: [sidebarView(PLUGIN_ID, VIEW_ID)],
    });
    await waitFor(() => expect(atHome(container)).toBe(true));

    await clickNav(container, "sidebar-routines");
    await waitFor(() => expect(isActive(container, "sidebar-routines")).toBe(true));

    await act(async () => {
      release();
    });
    await settle();

    expect(isActive(container, "sidebar-routines")).toBe(true);
    expect(isActive(container, PLUGIN_NAV_TESTID)).toBe(false);
  });

  it("drops a restore ALREADY waiting on its plugin when the list finally loads", async () => {
    // The other window, and the one the flag on the read cannot reach: here the
    // settings read has already resolved and been accepted, so the restored key
    // is parsed and HELD. Nothing about a later navigation goes near that read
    // again — only discarding what is held can stop it.
    const lateViews: unknown[] = [];
    const { container, emitPluginRuntimeUpdated } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView(PLUGIN_VIEW_KEY),
      pluginUiExtensions: lateViews,
    });
    await settle();
    expect(atHome(container)).toBe(true);

    await clickNav(container, "sidebar-routines");
    await waitFor(() => expect(isActive(container, "sidebar-routines")).toBe(true));

    // The plugin's view turns up late — a slow load, not an uninstall, so the
    // held key is now perfectly valid and would be entered.
    lateViews.push(sidebarView(PLUGIN_ID, VIEW_ID));
    await act(async () => {
      emitPluginRuntimeUpdated({ pluginId: PLUGIN_ID });
    });
    await settle();

    // The row exists now, which is what makes this assertion mean anything.
    expect(container.querySelector(`[data-testid="${PLUGIN_NAV_TESTID}"]`)).not.toBeNull();
    expect(isActive(container, "sidebar-routines")).toBe(true);
    expect(isActive(container, PLUGIN_NAV_TESTID)).toBe(false);
  });

  it("makes that pick the location the NEXT launch restores, not the superseded one", async () => {
    const { release, opts } = heldLaunch(settingsWithActiveView("work-board"));
    const first = await renderApp(opts);
    await waitFor(() => expect(atHome(first.container)).toBe(true));

    await clickNav(first.container, "sidebar-routines");
    await waitFor(() => expect(isActive(first.container, "sidebar-routines")).toBe(true));
    await act(async () => {
      release();
    });
    await settle();

    // Surviving the restore for THIS run is not enough. A choice that is never
    // written is the same lost place one restart later — the app would open on
    // the value the user just overrode.
    await waitFor(() =>
      expect(first.api.updateSettings).toHaveBeenCalledWith({
        system: { activeView: "routines" },
      }),
    );
    expect(first.api.updateSettings).not.toHaveBeenCalledWith({
      system: { activeView: "work-board" },
    });
    first.unmount();

    // Relaunched from exactly the patch asserted above, through the normal
    // restore path — no hand-picked value in between.
    const second = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("routines"),
    });
    await waitFor(() => expect(isActive(second.container, "sidebar-routines")).toBe(true));
  });
});
