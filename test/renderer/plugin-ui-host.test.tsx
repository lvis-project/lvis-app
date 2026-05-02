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

/**
 * Fire a synthetic did-attach event. The host reads the webContentsId via
 * the canonical `node.getWebContentsId()` accessor (#498), not via an
 * `e.webContentsId` payload (which the real Electron event doesn't carry),
 * so the helper stubs the method on the webview element.
 */
function fireDidAttach(webview: Element, webContentsId: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (webview as any).getWebContentsId = () => webContentsId;
  webview.dispatchEvent(new Event("did-attach"));
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

describe("PluginUiHostView — webview attach flow", () => {
  it("mounts webview with src=shellUrl from the start (preload only runs at first attach)", async () => {
    // #498: `<webview preload>` runs ONLY at first guest attach — subsequent
    // navigations do NOT re-execute preload, so the shell src must already
    // be the real shell URL on initial mount or `lvisPlugin` will be missing
    // in the new main world. The race vs registerPluginWebview is absorbed
    // by the host's `pendingEntryUrlResolvers` queue + the shell's 6s retry
    // budget.
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");

    expect(webview).not.toBeNull();
    expect(webview?.getAttribute("src")).toBe(SHELL_URL);
    expect(webview?.getAttribute("preload")).toBe(PRELOAD_URL);

    // did-attach still fires registerPluginWebview so the host can resolve
    // the shell's getEntryUrl request once the binding lands.
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
