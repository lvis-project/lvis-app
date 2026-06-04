/**
 * lvis:plugins:runtime-updated renderer subscriptions.
 *
 * Main broadcasts this channel to ALL windows after a plugin runtime
 * restart/reload (boot/steps/plugin-runtime.ts onEnable). Both renderer
 * shells must re-fetch the plugin UI extension list so PluginUiHostView
 * remounts the webview with the fresh runtimeRevision:
 *   - App (main window) — also refreshes plugin cards
 *   - DetachedView (standalone plugin BrowserWindow shell)
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import {
  makeMockLvisApi,
  makeMockLvisNamespace,
  type MockLvisApi,
} from "./mock-lvis-api.js";

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

describe("DetachedView — plugin runtime-updated subscription", () => {
  async function renderDetached(viewKey: string) {
    const mock = makeMockLvisApi();
    const { ns } = makeMockLvisNamespace();
    vi.stubGlobal("lvisApi", mock.api);
    vi.stubGlobal("lvis", ns);
    (window as unknown as { lvisApi: MockLvisApi }).lvisApi = mock.api;
    (window as unknown as { lvis: unknown }).lvis = ns;

    const { DetachedView } = await import("../../src/ui/renderer/DetachedView.js");
    render(<DetachedView viewKey={viewKey} />);
    return mock;
  }

  it("re-fetches plugin views in a detached plugin window", async () => {
    const { api, emitPluginRuntimeUpdated } = await renderDetached("plugin:meeting:main-panel");

    await waitFor(() => expect(api.onPluginRuntimeUpdated).toHaveBeenCalled());
    await waitFor(() => expect(api.listPluginUiExtensions).toHaveBeenCalled());
    api.listPluginUiExtensions.mockClear();

    await act(async () => {
      emitPluginRuntimeUpdated({ pluginId: "meeting" });
    });

    await waitFor(() => expect(api.listPluginUiExtensions).toHaveBeenCalledTimes(1));
  });

  it("does not subscribe for non-plugin detached views", async () => {
    const { api } = await renderDetached("memory");

    // The memory panel fetch settles the mount; the runtime-updated
    // subscription must never have been registered for a host view.
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    expect(api.onPluginRuntimeUpdated).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
