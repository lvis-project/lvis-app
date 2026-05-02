/**
 * Plugin UI Host — webview registration flow (#447 register-before-attach)
 *
 * Verifies that PluginUiHostView:
 *   1. Mounts <webview> with src="" (empty) initially.
 *   2. On did-attach, calls registerPluginWebview IPC and sets src to the
 *      shell URL only after registration succeeds.
 *   3. Falls back to error text when asset URLs are missing.
 *   4. Shows error text when registration fails.
 *
 * JSDOM has no real Electron webview — tests assert JSX shape and event
 * handling only, not actual Electron IPC or preload execution.
 */
import "./setup.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { PluginUiHostView, type PluginUiExtensionView } from "../../src/plugin-ui-host.js";

const SHELL_URL = "file:///c:/dist/src/plugin-ui-shell.html";
const PRELOAD_URL = "file:///c:/dist/src/plugin-preload.js";

const VIEW: PluginUiExtensionView = {
  pluginId: "com.example.test-plugin",
  extension: {
    id: "test-view",
    slot: "sidebar",
    kind: "embedded-module",
    title: "Test",
    entry: "ui/index.js",
    exportName: "mount",
  },
  entryUrl: "file:///c:/plugins/example/dist/ui/index.js",
};

let activeRoot: Root | null = null;

function mountHost(view: PluginUiExtensionView | null): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoot = root;
  act(() => {
    root.render(<PluginUiHostView view={view} />);
  });
  return container;
}

/** Fire a synthetic did-attach event (mirrors Electron's shape). */
function fireDidAttach(webview: Element, webContentsId: number) {
  const e = new Event("did-attach");
  Object.assign(e, { webContentsId });
  webview.dispatchEvent(e);
}

afterEach(() => {
  if (activeRoot) {
    act(() => activeRoot!.unmount());
    activeRoot = null;
  }
  for (const el of Array.from(document.body.children)) {
    el.remove();
  }
  vi.unstubAllGlobals();
});

describe("PluginUiHostView — register-before-attach flow", () => {
  it("mounts webview with src='' then sets src after did-attach + registration", async () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");

    expect(webview).not.toBeNull();
    // Before did-attach: src attribute absent (shell cannot load before registration).
    expect(webview?.getAttribute("src")).toBeNull();
    expect(webview?.getAttribute("preload")).toBe(PRELOAD_URL);

    // Simulate did-attach + await async IPC resolution.
    await act(async () => {
      fireDidAttach(webview!, 42);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(registerPluginWebview).toHaveBeenCalledWith({
      webContentsId: 42,
      pluginId: VIEW.pluginId,
      entryUrl: VIEW.entryUrl,
    });
    expect(webview?.getAttribute("src")).toBe(SHELL_URL);
  });

  it("shows error text and removes webview when registration returns ok=false", async () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: false, error: "unknown-plugin-id" });
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();
    // Before did-attach: src attribute absent (shell not yet loaded).
    expect(webview?.getAttribute("src")).toBeNull();

    await act(async () => {
      fireDidAttach(webview!, 7);
      await new Promise((r) => setTimeout(r, 0));
    });

    // After failed registration: error text replaces the webview.
    expect(container.querySelector("webview")).toBeNull();
    expect(container.textContent).toMatch(/unknown-plugin-id/);
  });

  it("falls back to error text when lvisApi.pluginShellUrl is missing", () => {
    vi.stubGlobal("lvisApi", { pluginPreloadUrl: PRELOAD_URL });

    const container = mountHost(VIEW);

    const webview = container.querySelector("webview");
    expect(webview).toBeNull();
    expect(container.textContent ?? "").toMatch(/lvisApi/);
  });

  it("falls back to error text when lvisApi.pluginPreloadUrl is missing", () => {
    vi.stubGlobal("lvisApi", { pluginShellUrl: SHELL_URL });

    const container = mountHost(VIEW);

    const webview = container.querySelector("webview");
    expect(webview).toBeNull();
    expect(container.textContent ?? "").toMatch(/lvisApi/);
  });
});
