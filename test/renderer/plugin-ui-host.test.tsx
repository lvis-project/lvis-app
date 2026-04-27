/**
 * Plugin UI Host — webview asset URL wiring (fix/plugin-webview-preload-bridge)
 *
 * Verifies that PluginUiHostView reads the deterministic plugin shell +
 * preload URLs from `window.lvisApi.pluginShellUrl` / `pluginPreloadUrl`
 * and threads them onto the rendered <webview src=... preload=...>.
 *
 * Regression: previously the host derived these via
 * `new URL("plugin-ui-shell.html", window.location.href)`, which broke
 * during the splash phase when `window.location.href` was a `data:text/html`
 * URL — the resolved preload path then pointed nowhere and Electron silently
 * skipped the preload, leaving `window.lvisPlugin` undefined inside the
 * plugin webview.
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

describe("PluginUiHostView — deterministic webview asset URLs", () => {
  it("renders <webview> with src and preload from window.lvisApi", () => {
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
    });

    const container = mountHost(VIEW);

    // querySelector("webview") works in JSDOM because Electron's <webview> is
    // just a custom element name; these tests assert JSX shape only, not actual
    // Electron webview behavior (preload execution, IPC wiring, etc.).
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();
    expect(webview?.getAttribute("src")).toBe(SHELL_URL);
    expect(webview?.getAttribute("preload")).toBe(PRELOAD_URL);
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
