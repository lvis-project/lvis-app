/**
 * lvis:plugins:runtime-updated renderer subscription.
 *
 * Main broadcasts this channel after a plugin runtime restart/reload
 * (boot/steps/plugin-runtime.ts onEnable). The renderer must re-fetch the plugin UI
 * extension list so PluginUiHostView remounts the webview with the fresh
 * runtimeRevision, and refresh its plugin cards.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { waitFor, act } from "@testing-library/react";
import { renderApp } from "./render-app.js";

describe("App — plugin runtime-updated subscription", () => {
  it("re-fetches plugin views and cards when the runtime is updated", async () => {
    const { api, emitPluginRuntimeUpdated } = await renderApp();
    await waitFor(() => expect(api.onPluginRuntimeUpdated).toHaveBeenCalled());
    await waitFor(() => expect(api.listPluginUiExtensions).toHaveBeenCalled());
    api.listPluginUiExtensions.mockClear();
    api.listPluginCards.mockClear();

    await act(async () => {
      emitPluginRuntimeUpdated({ pluginId: "meeting" });
    });

    await waitFor(() => expect(api.listPluginUiExtensions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.listPluginCards).toHaveBeenCalledTimes(1));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
