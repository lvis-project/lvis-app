/**
 * The app-menu settings path and the in-panel tab share one piece of state.
 *
 * `activateInlineSettings` (main) sends `lvis:view:activate`
 * `{viewKey:"settings", settingsTab}`, which the renderer routes through the
 * same `onOpenSettings(tab)` the in-app affordances use — it WRITES App's
 * `settingsTab`. The panel reads that value as its seed.
 *
 * While the panel kept its tab entirely to itself, those two drifted apart the
 * moment the user moved inside the panel, and the drift was not merely
 * cosmetic: because the seed only re-applies when the value CHANGES, a menu
 * command naming the tab App still thought it was on did nothing at all. This
 * pins the fix at the level a user would notice.
 */
import "./setup.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { activeSettingsTab, clickSettingsTab } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("settings tab: app-menu path and in-panel moves stay on one value", () => {
  it("re-runs a menu command for a tab the user has since navigated away from", async () => {
    const { container, emitViewActivate } = await renderApp({ hasApiKey: true });

    // Menu → Settings → Permissions.
    await act(async () => {
      emitViewActivate("settings", "permissions");
    });
    await waitFor(() => expect(activeSettingsTab(container)).toBe("permissions"));

    // The user moves to a different tab inside the panel.
    await act(async () => {
      clickSettingsTab(container, "chat");
    });
    await waitFor(() => expect(activeSettingsTab(container)).toBe("chat"));

    // The same menu command again. It is only a no-op if the app still believes
    // the panel is on "permissions" — which is exactly what the missing
    // read-back caused.
    await act(async () => {
      emitViewActivate("settings", "permissions");
    });
    await waitFor(() => expect(activeSettingsTab(container)).toBe("permissions"));
  });
});
